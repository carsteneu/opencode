import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { SyntaxStyle, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import {
  buildReplaySteps,
  buildTranscriptRows,
  clampPatchLines,
  clampReplayPaneWidth,
  compactPatch,
  filetypeFromPath,
  parseReplayPaneWidth,
  replayPaneDragWidth,
  timeLabel,
  type RawMessage,
  REPLAY_PANE_WIDTH_DEFAULT,
} from "./replay/replay-lib"

const STEPS_W = 62 // % width for the steps pane; transcript takes the rest

const [paneWidth, setPaneWidth] = createSignal(REPLAY_PANE_WIDTH_DEFAULT)
// Patch of the step the user is currently looking at (pane and fullscreen
// viewer keep it in sync); consumed by the copy command.
const [activePatch, setActivePatch] = createSignal<string | undefined>(undefined)

// Live-refresh: edit-part events arrive in streaming bursts, coalesce them
// into one debounced refetch so the pane follows a running session.
function subscribeSessionRefresh(api: TuiPluginApi, sessionID: () => string | undefined, refetch: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void refetch()
    }, 400)
  }
  const offPart = api.event.on("message.part.updated", (event) => {
    if (event.properties.sessionID === sessionID()) schedule()
  })
  const offMessage = api.event.on("message.updated", (event) => {
    if (event.properties.sessionID === sessionID()) schedule()
  })
  onCleanup(() => {
    clearTimeout(timer)
    offPart()
    offMessage()
  })
}

// Theme-derived syntax colors for <diff>. Compact subset of the TUI-internal
// getSyntaxRules (packages/tui/src/theme/index.ts) covering the visually
// dominant scopes; kept here because the TUI module is not importable from
// external plugins.
function syntaxStyleFor(theme: TuiThemeCurrent): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["comment"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.function", "function.method", "function.call"], style: { foreground: theme.syntaxFunction } },
    { scope: ["keyword.type", "type"], style: { foreground: theme.syntaxType, bold: true } },
    { scope: ["operator", "keyword.operator", "punctuation.delimiter"], style: { foreground: theme.syntaxOperator } },
    { scope: ["variable"], style: { foreground: theme.syntaxVariable } },
  ])
}

function ReplayPane(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  // SyntaxStyle is a native resource: replaced instances are destroyed one
  // frame after swap, the current one on unmount.
  let previousStyle: SyntaxStyle | undefined
  const syntaxStyle = createMemo(() => {
    const next = syntaxStyleFor(theme())
    const stale = previousStyle
    previousStyle = next
    if (stale && stale !== next) requestAnimationFrame(() => stale.destroy())
    return next
  })
  onCleanup(() => {
    const style = previousStyle
    requestAnimationFrame(() => style?.destroy())
  })
  const [loadError, setLoadError] = createSignal(false)
  const [messages, { refetch }] = createResource(
    () => props.sessionID || undefined,
    async (sessionID) => {
      try {
        const response = await props.api.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
        setLoadError(false)
        return (response.data ?? []) as RawMessage[]
      } catch (error) {
        setLoadError(true)
        return []
      }
    },
  )
  subscribeSessionRefresh(props.api, () => props.sessionID, refetch)
  createEffect(() => setActivePatch(current()?.patch))
  onCleanup(() => setActivePatch(undefined))
    const steps = createMemo(() => buildReplaySteps(messages() ?? []))
    const stepBoxes = new Map<number, BoxRenderable>()
    // kv loads asynchronously after boot, so re-sync once the store is ready.
    createEffect(() => {
      if (props.api.kv.ready) setPaneWidth(parseReplayPaneWidth(props.api.kv.get("replay_pane_width")))
    })
    const [active, setActive] = createSignal(0)
  // Reset selection and stale refs (fullscreen viewer clears the same map on
  // session switch) so scroll-follow never targets detached nodes.
  createEffect(() => {
    props.sessionID
    onCleanup(() => {
      stepBoxes.clear()
      setActive(0)
    })
  })
  const current = () => {
    const list = steps()
    return list[Math.min(active(), Math.max(list.length - 1, 0))]
  }

  let scrollSteps: ScrollBoxRenderable | undefined

  // Mouse-drag resize: the 1-col splitter strip anchors the drag, drags
  // bubble from it (or any pane child) up to this root. kv persists on
  // drag-end only, so live drags don't spam the store.
  let dragStartX: number | undefined
  let dragStartWidth = REPLAY_PANE_WIDTH_DEFAULT
  const applyDrag = (x: number) => {
    if (dragStartX === undefined) return
    setPaneWidth(replayPaneDragWidth(dragStartWidth, dragStartX, x))
  }
  const endDrag = () => {
    if (dragStartX === undefined) return
    dragStartX = undefined
    const next = clampReplayPaneWidth(parseReplayPaneWidth(paneWidth()))
    setPaneWidth(next)
    props.api.kv.set("replay_pane_width", next)
  }

  // Scroll-follow for the active step (same node.y pattern as the fullscreen
  // viewer), but only when the active step actually moved or grew — refetches
  // must not yank the user back while a session streams.
  let anchoredIndex = -1
  let anchoredCount = -1
  createEffect(() => {
    const step = current()
    const count = steps().length
    if (!step || (step.index === anchoredIndex && count === anchoredCount)) return
    anchoredIndex = step.index
    anchoredCount = count
    const left = stepBoxes.get(step.index)
    requestAnimationFrame(() => {
      const l = left ?? stepBoxes.get(step.index)
      if (l && scrollSteps) scrollSteps.scrollTo(scrollSteps.scrollTop + l.y - scrollSteps.viewport.y)
    })
  })

  return (
    <box
      flexDirection="row"
      width={parseReplayPaneWidth(paneWidth())}
      minHeight={0}
      border={["left", "right"]}
      borderColor={theme().border}
    >
      <box
        width={1}
        flexShrink={0}
        backgroundColor={theme().border}
        selectable={false}
        onMouseDown={(e) => {
          dragStartX = e.x
          dragStartWidth = parseReplayPaneWidth(paneWidth())
        }}
        onMouseDrag={(e) => applyDrag(e.x)}
        onMouseDragEnd={() => endDrag()}
        onMouseUp={() => {
          dragStartX = undefined
        }}
      />
      <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexShrink={0} paddingLeft={1}>
        <text fg={theme().text} bold content={`REPLAY · ${steps().length} steps`} />
        <text fg={theme().textMuted} content="ctrl+y hide · drag left border to resize · /replay fullscreen" />
      </box>
      <scrollbox ref={(el: ScrollBoxRenderable) => (scrollSteps = el)} flexGrow={1} minWidth={0} minHeight={0}>
        <For each={steps()}>
          {(step) => (
            <box
              ref={(el: BoxRenderable) => stepBoxes.set(step.index, el)}
              onMouseDown={() => setActive(step.index - 1)}
              border={step.index === current()?.index ? ["left"] : []}
              borderColor={theme().text}
              paddingLeft={1}
            >
              <text
                fg={step.index === current()?.index ? theme().text : theme().textMuted}
                content={`Step ${step.index}/${steps().length} · ${step.tool} ${step.filePath}`}
              />
                <Show when={step.index === current()?.index}>
                  <Show when={step.patch !== undefined} fallback={<text fg={theme().textMuted}>(no diff payload)</text>}>
                    <diff
                      diff={clampPatchLines(compactPatch(step.patch ?? ""))}
                      view="unified"
                      filetype={filetypeFromPath(step.filePath)}
                      syntaxStyle={syntaxStyle()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="char"
                      fg={theme().text}
                      addedBg={theme().diffAddedBg}
                      removedBg={theme().diffRemovedBg}
                      addedSignColor={theme().diffHighlightAdded}
                      removedSignColor={theme().diffHighlightRemoved}
                      lineNumberFg={theme().diffLineNumber}
                      addedLineNumberBg={theme().diffAddedLineNumberBg}
                      removedLineNumberBg={theme().diffRemovedLineNumberBg}
                    />
                  </Show>
                </Show>
              </box>
            )}
          </For>
          <Show when={steps().length === 0 && !messages.loading && !loadError()}>
            <text fg={theme().textMuted}>no edits in this session</text>
          </Show>
          <Show when={loadError()}>
            <text fg={theme().error}>failed to load session</text>
          </Show>
        </scrollbox>
      </box>
    </box>
    )
  }

function ReplayViewer(props: { api: TuiPluginApi }) {
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | { sessionID?: string; returnRoute?: unknown }
      | undefined

  const theme = () => props.api.theme.current
  // Same native-resource discipline as ReplayPane: destroy replaced styles
  // one frame after swap, the current one on unmount.
  let previousStyle: SyntaxStyle | undefined
  const syntaxStyle = createMemo(() => {
    const next = syntaxStyleFor(theme())
    const stale = previousStyle
    previousStyle = next
    if (stale && stale !== next) requestAnimationFrame(() => stale.destroy())
    return next
  })
  onCleanup(() => {
    const style = previousStyle
    requestAnimationFrame(() => style?.destroy())
  })

  const [loadError, setLoadError] = createSignal(false)
  const [messages, { refetch }] = createResource(
    () => params()?.sessionID,
    async (sessionID) => {
      try {
        const response = await props.api.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
        setLoadError(false)
        return (response.data ?? []) as RawMessage[]
      } catch (error) {
        setLoadError(true)
        return []
      }
    },
  )
  subscribeSessionRefresh(props.api, () => params()?.sessionID, refetch)
  createEffect(() => setActivePatch(current()?.patch))
  onCleanup(() => setActivePatch(undefined))

  const steps = createMemo(() => buildReplaySteps(messages() ?? []))
  const rows = createMemo(() => buildTranscriptRows(messages() ?? []))
  const [active, setActive] = createSignal(0)
  const [focusTranscript, setFocusTranscript] = createSignal(false)
  const current = () => {
    const list = steps()
    return list[Math.min(active(), Math.max(list.length - 1, 0))]
  }

  const next = () => {
    if (steps().length === 0) return
    setActive((i) => Math.min(i + 1, steps().length - 1))
  }
  const prev = () => {
    if (steps().length === 0) return
    setActive((i) => Math.max(i - 1, 0))
  }

  const scrollFocused = (dir: number) => {
    const sc = focusTranscript() ? scrollTranscript : scrollSteps
    sc?.scrollBy(6 * dir)
  }

  // Route-local key isolation: this layer is registered on mount and disposed
  // on unmount, mirroring the TUI-internal useBindings hook of diff-viewer.
  onMount(() => {
    const close = () => {
      const returnRoute = params()?.returnRoute as { name: string; params?: unknown } | undefined
      props.api.ui.dialog.clear()
      props.api.route.navigate(returnRoute?.name ?? "home", returnRoute?.params)
    }
    const dispose = props.api.keymap.registerLayer({
      commands: [
        { name: "replay.close", title: "Close replay viewer", run: () => close() },
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
        { key: "escape", cmd: "replay.close", desc: "Close replay viewer" },
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

  // Stale ref maps from the previous session invalidate on session switch.
  createEffect(() => {
    if (params()?.sessionID !== undefined) {
      stepBoxes.clear()
      transcriptBoxes.clear()
    }
  })

  // Scroll-follow: on step change bring the active step card and its origin
  // message to the top of each pane (node.y pattern from diff-viewer.tsx:238,
  // rAF-wrapped so initial layout settles before the first no-op lookup).
  // Refetch-only updates (same step, same count) keep the scroll position.
  let anchoredIndex = -1
  let anchoredCount = -1
  createEffect(() => {
    const step = current()
    const count = steps().length
    if (!step || (step.index === anchoredIndex && count === anchoredCount)) return
    anchoredIndex = step.index
    anchoredCount = count
    const left = stepBoxes.get(step.index)
    const right = transcriptBoxes.get(step.messageID)
    requestAnimationFrame(() => {
      const l = left ?? stepBoxes.get(step.index)
      if (l && scrollSteps) scrollSteps.scrollTo(scrollSteps.scrollTop + l.y - scrollSteps.viewport.y)
      const r = right ?? transcriptBoxes.get(step.messageID)
      if (r && scrollTranscript)
        scrollTranscript.scrollTo(scrollTranscript.scrollTop + r.y - scrollTranscript.viewport.y)
    })
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
              borderColor={theme().border}
              paddingLeft={1}
            >
              <text
                fg={step.index === current()?.index ? theme().text : theme().textMuted}
                content={`Step ${step.index}/${steps().length} · ${step.tool} ${step.filePath} · ${timeLabel(step.time)}`}
              />
                <Show when={step.index === current()?.index}>
                  <Show when={step.patch !== undefined} fallback={<text fg={theme().textMuted}>(no diff payload)</text>}>
                    <diff
                      diff={clampPatchLines(compactPatch(step.patch ?? ""))}
                      view="unified"
                      filetype={filetypeFromPath(step.filePath)}
                      syntaxStyle={syntaxStyle()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="char"
                      fg={theme().text}
                      addedBg={theme().diffAddedBg}
                      removedBg={theme().diffRemovedBg}
                      addedSignColor={theme().diffHighlightAdded}
                      removedSignColor={theme().diffHighlightRemoved}
                      lineNumberFg={theme().diffLineNumber}
                      addedLineNumberBg={theme().diffAddedLineNumberBg}
                      removedLineNumberBg={theme().diffRemovedLineNumberBg}
                    />
                  </Show>
                </Show>
            </box>
          )}
        </For>
        <Show when={steps().length === 0 && !messages.loading && !loadError()}>
          <text fg={theme().textMuted}>no edits in this session</text>
        </Show>
        <Show when={loadError()}>
          <text fg={theme().error}>failed to load session</text>
        </Show>
      </scrollbox>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (scrollTranscript = el)}
        width={`${100 - STEPS_W}%`}
        border={["left"]}
        borderColor={theme().border}
        paddingLeft={1}
      >
        <For each={rows()}>
          {(row) => (
            <box
              ref={(el: BoxRenderable) => {
                if (!transcriptBoxes.has(row.messageID)) transcriptBoxes.set(row.messageID, el)
              }}
              border={row.messageID === current()?.messageID ? ["left"] : []}
              borderColor={theme().border}
              paddingLeft={1}
            >
              <Show when={row.kind === "user"}>
                <text fg={theme().text} bold content="❯ " />
              </Show>
              <text
                fg={row.kind === "user" ? theme().text : row.kind === "tool" ? theme().textMuted : theme().textMuted}
                content={row.kind === "tool" ? `· ${row.tool} ${row.summary}` : row.text}
              />
            </box>
          )}
        </For>
        <Show when={messages.loading}>
          <text fg={theme().textMuted}>loading session…</text>
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
    api.slots.register({
      order: 50,
      slots: {
        session_replay(_ctx, props) {
          const slotProps = props as { session_id?: string }
          return <ReplayPane api={api} sessionID={slotProps.session_id ?? ""} />
        },
      },
    })
      const adjustPaneWidth = (delta: number) => {
        const next = clampReplayPaneWidth(parseReplayPaneWidth(paneWidth()) + delta)
        setPaneWidth(next)
        api.kv.set("replay_pane_width", next)
      }
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
          {
            name: "replay.pane.wider",
            title: "Widen replay pane",
            namespace: "palette",
            run() {
              adjustPaneWidth(4)
            },
          },
            {
              name: "replay.pane.narrower",
              title: "Narrow replay pane",
              namespace: "palette",
              run() {
                adjustPaneWidth(-4)
              },
            },
            {
              name: "replay.copy_patch",
              title: "Copy replay patch",
              namespace: "palette",
              run() {
                const patch = activePatch()
                if (patch === undefined) {
                  api.ui.toast({ message: "No replay patch to copy", variant: "warning" })
                  return
                }
                const ok = api.renderer.copyToClipboardOSC52(patch)
                api.ui.toast({
                  message: ok ? "Replay patch copied to clipboard!" : "Failed to copy patch",
                  variant: ok ? "success" : "error",
                })
              },
            },
        ],
      })
  },
}
