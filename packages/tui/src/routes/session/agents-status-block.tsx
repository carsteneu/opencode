import { Index, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useRoute, useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { PartialText } from "../../ui/partial-text"
import { type AgentRow, deriveAgentRows, formatDuration } from "./agents-status"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"

function AgentStatusRow(props: { row: AgentRow; now: number; onOpen: (id: string) => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const stateColor = () => {
    switch (props.row.state) {
      case "running":
        return theme.accent
      case "waiting":
        return theme.warning
      case "failed":
        return theme.error
      default:
        return theme.success
    }
  }

  const stateLabel = () => {
    switch (props.row.state) {
      case "running":
        return "running"
      case "waiting":
        return `waiting: ${props.row.reason ?? "unknown"}`
      case "failed":
        return `failed: ${props.row.reason ?? "unknown"}`
      default:
        return "done"
    }
  }

  const elapsed = () => formatDuration(props.now - (props.row.detailSince ?? props.row.startedAt))

  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onOpen(props.row.id)}
      backgroundColor={hover() ? theme.backgroundElement : undefined}
    >
      <text fg={theme.text}>{Locale.truncate(props.row.title, 32)}</text>
      <Show when={props.row.agent !== "subagent"}>
        <text fg={theme.textMuted}>@{Locale.titlecase(props.row.agent)}</text>
      </Show>
      <text fg={stateColor()} wrapMode="none">
        {props.row.state === "done" ? "✓" : "◗"} {stateLabel()}
      </text>
      <Show when={props.row.state === "running"}>
        <box flexDirection="row" flexShrink={0}>
          <Show when={props.row.detail}>
            {(detail) => (
              <text fg={theme.textMuted} wrapMode="none">
                {detail()} ·{" "}
              </text>
            )}
          </Show>
          <PartialText content={elapsed()} fg={theme.textMuted} width={8} truncate />
        </box>
      </Show>
      <Show when={props.row.state === "failed"}>
        <text fg={theme.textMuted} wrapMode="none">
          {Locale.truncate(props.row.reason ?? "", 60)}
        </text>
      </Show>
    </box>
  )
}

export function AgentsStatusBlock() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const { theme } = useTheme()

  const rows = createMemo(() =>
    deriveAgentRows({
      parentID: route.sessionID,
      sessions: sync.data.session,
      status: sync.data.session_status,
      messages: sync.data.message,
      parts: sync.data.part,
    }),
  )
  const activeCount = createMemo(() => rows().filter((x) => x.state === "running" || x.state === "waiting").length)

  const [expanded, setExpanded] = createSignal(true)
  const [hoverHeader, setHoverHeader] = createSignal(false)

  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!expanded() || activeCount() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  useTerminalDimensions()

  const open = (sessionID: string) => navigate({ type: "session", sessionID })

  return (
    <Show when={rows().length > 0}>
      <box flexShrink={0}>
        <box
          paddingTop={0}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={1}
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border}
          flexShrink={0}
          backgroundColor={theme.backgroundPanel}
        >
          <box
            flexDirection="row"
            gap={1}
            onMouseOver={() => setHoverHeader(true)}
            onMouseOut={() => setHoverHeader(false)}
            onMouseUp={() => setExpanded((x) => !x)}
            backgroundColor={hoverHeader() ? theme.backgroundElement : undefined}
          >
            <text fg={theme.text}>
              <b>Agents</b>
            </text>
            <text fg={activeCount() > 0 ? theme.accent : theme.textMuted}>
              {activeCount()}/{rows().length} active
            </text>
            <text fg={theme.textMuted}>{expanded() ? "collapse" : "expand"}</text>
          </box>
          <Show when={expanded()}>
            <box flexDirection="column" gap={0}>
              <Index each={rows()}>{(row) => <AgentStatusRow row={row()} now={now()} onOpen={open} />}</Index>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}
