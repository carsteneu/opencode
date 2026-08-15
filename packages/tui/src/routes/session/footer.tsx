import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"
import { TokenRateMeter } from "../../util/token-rate"
import { Locale } from "../../util/locale"

// Hide the live rate shortly after streaming stops (no part deltas).
const ACTIVITY_TIMEOUT = 2500

function TokenRate() {
  const { theme } = useTheme()
  const event = useEvent()
  const meter = new TokenRateMeter()
  let currentId: string | undefined
  let currentTokens = 0
  let lastActivityAt = 0
  const [tick, setTick] = createSignal(0)

  const unsubs = [
    event.on("message.updated", (evt) => {
      const info = evt.properties.info
      if (info.role !== "assistant") return
      const tokens = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
      lastActivityAt = Date.now()
      if (info.id !== currentId) {
        currentId = info.id
        currentTokens = 0
        meter.reset()
      }
      if (tokens >= currentTokens) {
        currentTokens = tokens
        meter.add(currentTokens, lastActivityAt)
      }
    }),
    event.on("message.part.delta", () => {
      lastActivityAt = Date.now()
    }),
  ]
  const timer = setInterval(() => setTick((t) => (t + 1) % 1_000_000_000), 1000)
  onCleanup(() => {
    for (const unsub of unsubs) unsub()
    clearInterval(timer)
  })

  const view = createMemo(() => {
    tick()
    const now = Date.now()
    if (now - lastActivityAt > ACTIVITY_TIMEOUT) return
    if (currentTokens <= 0) return
    return {
      rate: meter.rate(now),
      total: currentTokens,
    }
  })

  return (
    <Show when={view()} fallback={<></>}>
      {(v) => (
        <text fg={theme.textMuted} flexShrink={0}>
          {Math.round(v().rate)} tok/s · {Locale.number(v().total)} tok
        </text>
      )}
    </Show>
  )
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
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <TokenRate />
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
