import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { buildReplaySteps, buildTranscriptRows, timeLabel, type RawMessage } from "./replay/replay-lib"

const STEPS_W = 62 // % width for the steps pane; transcript takes the rest

function ReplayViewer(props: { api: TuiPluginApi }) {
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | { sessionID?: string; returnRoute?: unknown }
      | undefined

  const [messages] = createResource(
    () => params()?.sessionID,
    async (sessionID) => {
      const response = await props.api.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
      return (response.data ?? []) as RawMessage[]
    },
  )

  const steps = createMemo(() => buildReplaySteps(messages() ?? []))
  const rows = createMemo(() => buildTranscriptRows(messages() ?? []))
  const [active, setActive] = createSignal(0)
  const [focusTranscript, setFocusTranscript] = createSignal(false)
  const current = () => {
    const list = steps()
    return list[Math.min(active(), Math.max(list.length - 1, 0))]
  }

  const next = () => setActive((i) => Math.min(i + 1, steps().length - 1))
  const prev = () => setActive((i) => Math.max(i - 1, 0))

  const scrollFocused = (dir: number) => {
    const sc = focusTranscript() ? scrollTranscript : scrollSteps
    sc?.scrollBy(6 * dir)
  }

  // Route-local key isolation: this layer is registered on mount and disposed
  // on unmount, mirroring the TUI-internal useBindings hook of diff-viewer.
  onMount(() => {
    const dispose = props.api.keymap.registerLayer({
      commands: [
        { name: "replay.next_step", title: "Next replay step", run: () => next() },
        { name: "replay.prev_step", title: "Previous replay step", run: () => prev() },
        {
          name: "replay.down",
          title: "Move replay down",
          run: () => {
            if (focusTranscript()) scrollFocused(1)
            else next()
          },
        },
        {
          name: "replay.up",
          title: "Move replay up",
          run: () => {
            if (focusTranscript()) scrollFocused(-1)
            else prev()
          },
        },
        { name: "replay.switch_pane", title: "Switch replay pane focus", run: () => setFocusTranscript((f) => !f) },
      ],
      bindings: [
        { key: "n,alt+down", cmd: "replay.next_step", desc: "Next replay step" },
        { key: "p,alt+up", cmd: "replay.prev_step", desc: "Previous replay step" },
        { key: "j,down", cmd: "replay.down", desc: "Move replay down" },
        { key: "k,up", cmd: "replay.up", desc: "Move replay up" },
        { key: "tab", cmd: "replay.switch_pane", desc: "Switch pane focus" },
      ],
    })
    onCleanup(dispose)
  })

  let scrollSteps: ScrollBoxRenderable | undefined
  let scrollTranscript: ScrollBoxRenderable | undefined
  const stepBoxes = new Map<number, BoxRenderable>()
  const transcriptBoxes = new Map<string, BoxRenderable>()

  // Scroll-follow: on step change bring the active step card and its origin
  // message to the top of each pane (node.y pattern from diff-viewer.tsx:238).
  createEffect(() => {
    const step = current()
    if (!step) return
    const left = stepBoxes.get(step.index)
    if (left && scrollSteps) scrollSteps.scrollTo(scrollSteps.scrollTop + left.y - scrollSteps.viewport.y)
    const right = transcriptBoxes.get(step.messageID)
    if (right && scrollTranscript)
      scrollTranscript.scrollTo(scrollTranscript.scrollTop + right.y - scrollTranscript.viewport.y)
  })

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (scrollSteps = el)}
        flexGrow={1}
        minWidth={0}
        minHeight={0}
        borderTop
        borderLeft
      >
        <For each={steps()}>
          {(step) => (
            <box
              marginBottom={1}
              ref={(el: BoxRenderable) => stepBoxes.set(step.index, el)}
              border={step.index === current()?.index ? ["left"] : []}
              borderColor="#5f87af"
              paddingLeft={1}
            >
              <text
                fg={step.index === current()?.index ? "#ffffff" : "#888888"}
                content={`Step ${step.index}/${steps().length} · ${step.tool} ${step.filePath} · ${timeLabel(step.time)}`}
              />
              <Show when={step.patch !== undefined} fallback={<text fg="#666666">(no diff payload)</text>}>
                <For each={(step.patch ?? "").split("\n")}>
                  {(line) => (
                    <text
                      fg={line.startsWith("+") ? "#87af87" : line.startsWith("-") ? "#af8787" : "#888888"}
                      content={line}
                    />
                  )}
                </For>
              </Show>
            </box>
          )}
        </For>
        <Show when={steps().length === 0 && !messages.loading}>
          <text fg="#888888">no edits in this session</text>
        </Show>
      </scrollbox>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (scrollTranscript = el)}
        width={`${100 - STEPS_W}%`}
        border={["left"]}
        borderColor="#444444"
        paddingLeft={1}
      >
        <For each={rows()}>
          {(row) => (
            <box
              ref={(el: BoxRenderable) => transcriptBoxes.set(row.messageID, el)}
              border={row.messageID === current()?.messageID ? ["left"] : []}
              borderColor="#5f87af"
              paddingLeft={1}
            >
              <Show when={row.kind === "user"}>
                <text fg="#ffffff" bold content="❯ " />
              </Show>
              <text
                fg={row.kind === "user" ? "#ffffff" : row.kind === "tool" ? "#666666" : "#aaaaaa"}
                content={row.kind === "tool" ? `· ${row.tool} ${row.summary}` : row.text}
              />
            </box>
          )}
        </For>
        <Show when={messages.loading}>
          <text fg="#888888">loading session…</text>
        </Show>
      </scrollbox>
    </box>
  )
}

export default {
  id: "replay-viewer",
  tui(api: TuiPluginApi) {
    api.route.register([
      { name: "replay", render: () => <ReplayViewer api={api} /> },
    ])
    api.keymap.registerLayer({
      commands: [
        {
          name: "replay.open",
          title: "Open replay viewer",
          slashName: "replay",
          category: "VCS",
          namespace: "palette",
          run() {
            const current = api.route.current
            const sessionID = "params" in current ? current.params?.sessionID : undefined
            api.route.navigate("replay", { sessionID, returnRoute: current })
            api.ui.dialog.clear()
          },
        },
      ],
    })
  },
}
