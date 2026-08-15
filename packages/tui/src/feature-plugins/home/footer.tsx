import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { TokenRateMeter } from "../../util/token-rate"
import { Locale } from "../../util/locale"

// Hide the live rate shortly after streaming stops (no part deltas).
const ACTIVITY_TIMEOUT = 2500

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const out = abbreviateHome(selected.directory, paths.home)
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    if (branch) return out + ":" + branch
    return out
  })

  return <Show when={dir()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
}

function TokenRate(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const meter = new TokenRateMeter()
  let currentId: string | undefined
  let currentTokens = 0
  let lastActivityAt = 0
  const [tick, setTick] = createSignal(0)

  const unsubs = [
    props.api.event.on("message.updated", (evt) => {
      const info = evt.properties.info
      if (info.role !== "assistant") return
      const tokens = info.tokens.output + info.tokens.reasoning
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
    props.api.event.on("message.part.delta", () => {
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
    return {
      rate: meter.rate(now),
      total: currentTokens,
    }
  })

  return (
    <Show when={view()} fallback={<></>}>
      {(v) => (
        <text fg={theme().textMuted} flexShrink={0}>
          {Math.round(v().rate)} tok/s · {Locale.number(v().total)} tok
        </text>
      )}
    </Show>
  )
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <TokenRate api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
