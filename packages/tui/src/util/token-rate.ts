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
    this.samples.push({ at, tokens })
    this.prune(at)
  }

  reset() {
    this.samples = []
  }

  // Average tokens/second across the retained window.
  rate(at = Date.now()): number {
    this.prune(at)
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
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
