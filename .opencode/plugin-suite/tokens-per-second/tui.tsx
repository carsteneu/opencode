/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"

// v2's core counter (routes/session/rows.ts turnTokensPerSecond) is undefined
// whenever the provider delivers no usage timing (gd-flash, some gateways), so
// its assistant-footer cell stays empty. v1 counted client-side from the text
// stream instead; this plugin adds that live estimate to the prompt footer
// without touching the core counter. Port of v1 util/token-rate.ts as wired in
// v1 routes/session/footer.tsx (window and refresh both 1000ms there), counting
// only text deltas like v1 did (`field === "text"`): it is an "out" estimate, so
// on reasoning models it reads below the core cell, and the two cells are
// independent.
const WINDOW_MS = 1000
const REFRESH_MS = 1000

type Sample = { at: number; tokens: number }

class TokenRateMeter {
  private samples: Sample[] = []

  constructor(private readonly windowMs: number) {}

  // Tokens are monotonic for one assistant message; out-of-order or duplicate
  // updates are ignored. Several deltas in the same millisecond keep the last
  // cumulative count instead of counting one batch as many samples.
  add(tokens: number, at: number) {
    const last = this.samples[this.samples.length - 1]
    if (last && tokens <= last.tokens) return
    if (last?.at === at) {
      last.tokens = tokens
      return
    }
    this.samples.push({ at, tokens })
    this.prune(at)
  }

  reset() {
    this.samples = []
  }

  rate(at: number): number {
    this.prune(at)
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    // A stalled stream reads 0 so the cell disappears instead of freezing.
    if (at - last.at > this.windowMs) return 0
    const elapsed = (last.at - first.at) / 1000
    if (elapsed <= 0) return 0
    return (last.tokens - first.tokens) / elapsed
  }

  private prune(at: number) {
    const windowStart = at - this.windowMs
    let drop = 0
    while (drop < this.samples.length - 2 && this.samples[drop].at < windowStart) drop++
    if (drop > 0) this.samples.splice(0, drop)
  }
}

function TokensPerSecond(props: { context: Plugin.Context; sessionID?: string }) {
  const [rate, setRate] = createSignal(0)
  const meter = new TokenRateMeter(WINDOW_MS)
  let messageID: string | undefined
  let characters = 0
  let latestDeltaAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    latestDeltaAt = undefined
    setRate(0)
  }
  const refresh = () => {
    timer = undefined
    const now = Date.now()
    setRate(meter.rate(now))
    if (latestDeltaAt === undefined) return
    const remaining = latestDeltaAt + WINDOW_MS - now
    if (remaining < 0) {
      latestDeltaAt = undefined
      return
    }
    timer = setTimeout(refresh, Math.min(REFRESH_MS, remaining + 1))
  }

  const unsubscribe = props.context.data.on("session.text.delta", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    if (event.data.assistantMessageID !== messageID) {
      messageID = event.data.assistantMessageID
      characters = 0
      meter.reset()
      stop()
    }
    characters += event.data.delta.length
    const now = Date.now()
    // Fractional estimate so short deltas still move the meter.
    meter.add(characters / 4, now)
    latestDeltaAt = now
    if (!timer) timer = setTimeout(refresh, REFRESH_MS)
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        messageID = undefined
        characters = 0
        meter.reset()
        stop()
      },
    ),
  )
  onCleanup(() => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  })

  return (
    <Show when={Math.round(rate()) > 0}>
      <text fg={props.context.theme.text.muted} wrapMode="none" flexShrink={0}>
        out ~{Math.round(rate())} tk/s
      </text>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.prompt.tokens-per-second",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => <TokensPerSecond context={context} sessionID={props.sessionID} />,
    })
  },
})
