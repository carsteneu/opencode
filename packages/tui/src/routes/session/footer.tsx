import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"
import { LiveOutputRate } from "../../util/token-rate"
import { fg, t } from "@opentui/core"
import { PartialText } from "../../ui/partial-text"

const TOKEN_RATE_REFRESH_MS = 1000
const TOKEN_RATE_WINDOW_MS = 3000

function TokenRate() {
  const { theme } = useTheme()
  const event = useEvent()
  const route = useRoute()
  const output = new LiveOutputRate(TOKEN_RATE_WINDOW_MS)
  const [rate, setRate] = createSignal(0)
  let sessionID = route.data.type === "session" ? route.data.sessionID : undefined
  let messageID: string | undefined
  let latestDeltaAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  output.selectSession(sessionID)

  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    latestDeltaAt = undefined
    setRate(0)
  }

  const refresh = () => {
    timer = undefined
    const now = Date.now()
    setRate(output.rate(now))
    if (latestDeltaAt === undefined) return
    const remaining = latestDeltaAt + TOKEN_RATE_WINDOW_MS - now
    if (remaining < 0) {
      latestDeltaAt = undefined
      return
    }
    timer = setTimeout(refresh, Math.min(TOKEN_RATE_REFRESH_MS, remaining + 1))
  }

  createEffect(() => {
    const next = route.data.type === "session" ? route.data.sessionID : undefined
    if (next === sessionID) return
    sessionID = next
    messageID = undefined
    output.selectSession(next)
    stop()
  })
  const unsubs = [
    event.on("message.updated", (evt) => {
      const info = evt.properties.info
      if (info.role !== "assistant" || info.sessionID !== sessionID || info.id === messageID) return
      messageID = info.id
      output.selectMessage(info.sessionID, info.id)
      stop()
    }),
    event.on("message.part.delta", (evt) => {
      const input = evt.properties
      if (input.sessionID !== sessionID || input.field !== "text") return
      if (!messageID) messageID = input.messageID
      if (input.messageID !== messageID) return
      const now = Date.now()
      output.add(input, now)
      latestDeltaAt = now
      if (!timer) timer = setTimeout(refresh, TOKEN_RATE_REFRESH_MS)
    }),
  ]
  onCleanup(() => {
    for (const unsub of unsubs) unsub()
    if (timer) clearTimeout(timer)
  })

  return <PartialText content={`out ~${Math.round(rate())} tk/s`} fg={theme.textMuted} width={14} truncate />
}

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()
  const welcome = createMemo(() => t`Get started ${fg(theme.textMuted)("/connect")}`)
  const lspStatus = createMemo(
    () => t`${fg(lsp().length > 0 ? theme.success : theme.textMuted)("•")} ${lsp().length} LSP`,
  )
  const mcpStatus = createMemo(() => t`${fg(mcpError() ? theme.error : theme.success)("⊙")} ${mcp()} MCP`)

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <box flexGrow={1} minWidth={0}>
        <PartialText content={directory()} fg={theme.textMuted} width="100%" truncate />
      </box>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <TokenRate />
        <Switch>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <PartialText
                content={`△ ${permissions().length} Permission${permissions().length > 1 ? "s" : ""}`}
                fg={theme.warning}
                width={16}
                truncate
              />
            </Show>
            <PartialText content={lspStatus()} fg={theme.text} width={8} truncate />
            <Show when={mcp()}>
              <PartialText content={mcpStatus()} fg={theme.text} width={8} truncate />
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
          <Match when={true}>
            <PartialText content={store.welcome ? welcome() : ""} fg={theme.text} width={20} />
          </Match>
        </Switch>
      </box>
    </box>
  )
}
