import { Index, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MouseEvent } from "@opentui/core"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useStorage } from "../../context/storage"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { type AgentRow, deriveAgentRows, formatDuration } from "./agents-status"

const DISMISSED_KEY = "agents-dismissed"

function AgentStatusRow(props: {
  row: AgentRow
  now: number
  onOpen: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const theme = useTheme()
  const [hover, setHover] = createSignal(false)

  const stateColor = () => {
    switch (props.row.state) {
      case "running":
        return theme.text.action.primary.base
      case "waiting":
        return theme.text.feedback.warning.base
      case "failed":
        return theme.text.feedback.error.base
      default:
        return theme.text.feedback.success.base
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
      backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : undefined}
    >
      <text fg={theme.text.base}>{Locale.truncate(props.row.title, 32)}</text>
      <Show when={props.row.agent !== "subagent"}>
        <text fg={theme.text.muted}>@{Locale.titlecase(props.row.agent)}</text>
      </Show>
      <text fg={stateColor()} wrapMode="none">
        {props.row.state === "done" ? "✓" : "◗"} {stateLabel()}
      </text>
      <Show when={props.row.state === "running"}>
        <box flexDirection="row" flexShrink={0}>
          <Show when={props.row.detail}>
            {(detail) => (
              <text fg={theme.text.muted} wrapMode="none">
                {detail()} ·{" "}
              </text>
            )}
          </Show>
          <text fg={theme.text.muted}>{elapsed()}</text>
        </box>
      </Show>
      <Show when={props.row.state === "failed"}>
        <text fg={theme.text.muted} wrapMode="none">
          {Locale.truncate(props.row.reason ?? "", 60)}
        </text>
      </Show>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : undefined}
        onMouseUp={(event: MouseEvent) => {
          event.stopPropagation()
          props.onDismiss(props.row.id)
        }}
      >
        <text fg={theme.text.muted}>✕</text>
      </box>
    </box>
  )
}

export function AgentsStatusBlock() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const data = useData()
  const theme = useTheme()
  const [dismissedStore, updateDismissed] = useStorage().store<{
    sessions: Record<string, string[] | undefined>
  }>(DISMISSED_KEY, { initial: { sessions: {} } })

  // Dismissals survive session switches and TUI restarts because they live in the
  // shared storage store keyed by parent session rather than in component state.
  const dismissed = createMemo(() => dismissedStore.sessions[route.sessionID] ?? [])
  const dismiss = (id: string) => {
    if (dismissed().includes(id)) return
    void updateDismissed((draft) => {
      draft.sessions[route.sessionID] = [...(draft.sessions[route.sessionID] ?? []), id]
    })
  }

  const children = createMemo(() =>
    data.session.family(route.sessionID).flatMap((id) => {
      const info = data.session.get(id)
      return info?.parentID === route.sessionID ? [info] : []
    }),
  )

  // A child session's transcript arrives over the live event stream, so a child that started while
  // this client was connected reports its retry state and running tool. A child already running
  // when this client attached (restart, reconnect, or a second client) has no transcript until its
  // next step and shows state only: the store drops child events it has no row for, and nothing
  // re-syncs a child transcript.
  const rows = createMemo(() =>
    deriveAgentRows({
      parentID: route.sessionID,
      sessions: data.session.list(),
      status: Object.fromEntries(children().map((child) => [child.id, data.session.status(child.id)])),
      messages: Object.fromEntries([
        [route.sessionID, data.session.message.list(route.sessionID)],
        ...children().map((child) => [child.id, data.session.message.list(child.id)]),
      ]),
      dismissed: dismissed(),
    }),
  )
  const activeCount = createMemo(() => rows().filter((row) => row.state === "running" || row.state === "waiting").length)

  const [expanded, setExpanded] = createSignal(true)
  const [hoverHeader, setHoverHeader] = createSignal(false)

  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!expanded() || activeCount() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const open = (sessionID: string) => navigate({ type: "session", sessionID })

  return (
    <Show when={rows().length > 0}>
      <box flexShrink={0}>
        <box
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={1}
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border.base}
          flexShrink={0}
          backgroundColor={theme.background.raised.base}
        >
          <box
            flexDirection="row"
            gap={1}
            onMouseOver={() => setHoverHeader(true)}
            onMouseOut={() => setHoverHeader(false)}
            onMouseUp={() => setExpanded((value) => !value)}
            backgroundColor={hoverHeader() ? theme.decrease(theme.background.raised.base) : undefined}
          >
            <text fg={theme.text.base}>
              <b>Agents</b>
            </text>
            <text fg={activeCount() > 0 ? theme.text.action.primary.base : theme.text.muted}>
              {activeCount()}/{rows().length} active
            </text>
            <text fg={theme.text.muted}>{expanded() ? "collapse" : "expand"}</text>
          </box>
          <Show when={expanded()}>
            <box flexDirection="column" gap={0}>
              <Index each={rows()}>
                {(row) => <AgentStatusRow row={row()} now={now()} onOpen={open} onDismiss={dismiss} />}
              </Index>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}
