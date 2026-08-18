import { Token } from "@opencode-ai/core/util/token"

type Sample = { at: number; tokens: number }

/**
 * Rolling token-rate meter. `add` is fed cumulative generation-token counts for
 * the current assistant message; `rate` returns tokens/second over a sliding
 * window. Shared source so the agents-status model can reuse the metric.
 */
export class TokenRateMeter {
  private samples: Sample[] = []

  constructor(private windowMs = 3000) {}

  // `tokens` is monotonic for a given message; out-of-order or duplicate
  // updates (server coalescing, step re-publish) are ignored.
  add(tokens: number, at: number) {
    const last = this.samples[this.samples.length - 1]
    if (last && tokens <= last.tokens) return
    // The SDK flushes several deltas synchronously; keep the final cumulative
    // count for that timestamp instead of treating one batch as many samples.
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

  // Average tokens/second across the retained window. When the newest sample
  // is older than the window the stream has stalled — the rate reads 0 so the
  // needle falls back to idle instead of freezing at the last value.
  rate(at = Date.now()): number {
    this.prune(at)
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
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

export class LiveOutputRate {
  private meter: TokenRateMeter
  private sessionID: string | undefined
  private messageID: string | undefined
  private characters = 0

  constructor(windowMs = 3000) {
    this.meter = new TokenRateMeter(windowMs)
  }

  selectSession(sessionID: string | undefined) {
    if (sessionID === this.sessionID) return
    this.sessionID = sessionID
    this.messageID = undefined
    this.characters = 0
    this.meter.reset()
  }

  selectMessage(sessionID: string, messageID: string) {
    if (sessionID !== this.sessionID || messageID === this.messageID) return
    this.messageID = messageID
    this.characters = 0
    this.meter.reset()
  }

  add(input: { sessionID: string; messageID: string; field: string; delta: string }, at: number) {
    if (input.sessionID !== this.sessionID || input.field !== "text") return
    if (!this.messageID) this.selectMessage(input.sessionID, input.messageID)
    if (input.messageID !== this.messageID) return
    this.characters += input.delta.length
    this.meter.add(Token.estimateLength(this.characters), at)
  }

  rate(at = Date.now()) {
    return this.meter.rate(at)
  }
}
