import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { TokenRateMeter } from "../../util/token-rate"
import { Locale } from "../../util/locale"

// Hide the live rate shortly after streaming stops (no part deltas). The cell
// lives in the session view (next to the prompt) where generation is visible.
const ACTIVITY_TIMEOUT = 2500

const id = "internal:session-token-rate"

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
    if (currentTokens <= 0) return
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

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right() {
        return <TokenRate api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
