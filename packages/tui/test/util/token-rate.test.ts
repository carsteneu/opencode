import { describe, expect, test } from "bun:test"
import { LiveOutputRate, TokenRateMeter } from "../../src/util/token-rate"

describe("util.token-rate", () => {
  test("rate is 0 with fewer than two samples", () => {
    const meter = new TokenRateMeter()
    expect(meter.rate(0)).toBe(0)
    meter.add(10, 0)
    expect(meter.rate(0)).toBe(0)
  })

  test("computes tokens per second from cumulative samples", () => {
    const meter = new TokenRateMeter()
    meter.add(25, 0)
    meter.add(50, 500)
    meter.add(75, 1000)
    meter.add(100, 1500)
    expect(meter.rate(1500)).toBeCloseTo(50, 5)
  })

  test("replaces cumulative samples from the same SDK flush timestamp", () => {
    const meter = new TokenRateMeter()
    meter.add(10, 0)
    meter.add(20, 0)
    meter.add(30, 1000)
    expect(meter.rate(1000)).toBeCloseTo(10, 5)
  })

  test("steady 10 tok/s over a 3s window", () => {
    const meter = new TokenRateMeter()
    meter.add(10, 0)
    meter.add(20, 1000)
    meter.add(30, 2000)
    meter.add(40, 3000)
    expect(meter.rate(3000)).toBeCloseTo(10, 5)
  })

  test("prunes samples older than the window but keeps the newest two", () => {
    const meter = new TokenRateMeter(1000)
    meter.add(10, 0)
    meter.add(20, 1000)
    meter.add(30, 2000)
    meter.add(40, 3000)
    // After pruning only the newest two remain (at 2000, 3000).
    expect(meter.rate(3000)).toBeCloseTo(10, 5)
  })

  test("does not move backwards on non-monotonic samples", () => {
    const meter = new TokenRateMeter()
    meter.add(10, 0)
    meter.add(9, 500) // duplicate/out-of-order guard: ignored
    meter.add(20, 1000)
    expect(meter.rate(1000)).toBeCloseTo(10, 5)
  })

  test("reset clears all samples", () => {
    const meter = new TokenRateMeter()
    meter.add(5, 0)
    meter.add(10, 1000)
    meter.reset()
    expect(meter.rate(2000)).toBe(0)
    meter.add(10, 2000)
    expect(meter.rate(2000)).toBe(0)
  })

  test("rate decays to 0 when the newest sample is older than the window", () => {
    const meter = new TokenRateMeter(3000)
    meter.add(10, 0)
    meter.add(40, 1000)
    expect(meter.rate(1500)).toBeCloseTo(30, 5)
    // just inside the window: still live
    expect(meter.rate(1000 + 3000)).toBeCloseTo(30, 5)
    // past the window: needle returns to 0
    expect(meter.rate(1000 + 3001)).toBe(0)
    expect(meter.rate(60_000)).toBe(0)
  })
})

describe("util.live-output-rate", () => {
  test("estimates a chunking-invariant rate from cumulative character counts", () => {
    const whole = new LiveOutputRate()
    whole.selectSession("session")
    whole.selectMessage("session", "message")
    whole.add(delta("x".repeat(40)), 0)
    whole.add(delta("x".repeat(40)), 1000)

    const chunked = new LiveOutputRate()
    chunked.selectSession("session")
    chunked.selectMessage("session", "message")
    ;[1, 9, 30].forEach((value) => chunked.add(delta("x".repeat(value)), 0))
    ;[3, 7, 11, 19].forEach((value) => chunked.add(delta("x".repeat(value)), 1000))

    expect(whole.rate(1000)).toBeCloseTo(10, 5)
    expect(chunked.rate(1000)).toBeCloseTo(whole.rate(1000), 5)
  })

  test("starts generation timing at the first delta", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")
    output.selectMessage("session", "message")

    output.add(delta("x".repeat(40)), 10_000)
    expect(output.rate(10_000)).toBe(0)
    output.add(delta("x".repeat(40)), 11_000)
    expect(output.rate(11_000)).toBeCloseTo(10, 5)
  })

  test("uses the first delta as the message fallback and ignores other sessions and messages", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")

    output.add(delta("x".repeat(40)), 0)
    output.selectMessage("session", "message")
    output.add(delta("x".repeat(400), { sessionID: "other-session" }), 500)
    output.add(delta("x".repeat(400), { messageID: "other-message" }), 500)
    output.selectMessage("other-session", "other-message")
    output.add(delta("x".repeat(40)), 1000)

    expect(output.rate(1000)).toBeCloseTo(10, 5)
  })

  test("resets when the selected assistant message changes", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")
    output.selectMessage("session", "first")
    output.add(delta("x".repeat(40), { messageID: "first" }), 0)
    output.add(delta("x".repeat(40), { messageID: "first" }), 1000)
    expect(output.rate(1000)).toBeCloseTo(10, 5)

    output.selectMessage("session", "second")
    expect(output.rate(1000)).toBe(0)
    output.add(delta("x".repeat(400), { messageID: "first" }), 1500)
    output.add(delta("x".repeat(40), { messageID: "second" }), 2000)
    expect(output.rate(2000)).toBe(0)
    output.add(delta("x".repeat(40), { messageID: "second" }), 3000)
    expect(output.rate(3000)).toBeCloseTo(10, 5)
  })

  test("keeps the measured rate when final usage republishes the selected message", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")
    output.selectMessage("session", "message")
    output.add(delta("x".repeat(40)), 0)
    output.add(delta("x".repeat(40)), 1000)

    output.selectMessage("session", "message")
    expect(output.rate(1000)).toBeCloseTo(10, 5)
  })

  test("counts text-field deltas from separate reasoning and response parts", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")
    output.selectMessage("session", "message")
    output.add(delta("r".repeat(40), { partID: "reasoning" }), 0)
    output.add(delta("t".repeat(40), { partID: "response" }), 1000)

    expect(output.rate(1000)).toBeCloseTo(10, 5)
  })

  test("ignores non-text fields", () => {
    const output = new LiveOutputRate()
    output.selectSession("session")
    output.selectMessage("session", "message")
    output.add(delta("x".repeat(40)), 0)
    output.add(delta("x".repeat(400), { field: "input" }), 500)
    output.add(delta("x".repeat(40)), 1000)

    expect(output.rate(1000)).toBeCloseTo(10, 5)
  })

  test("decays to zero three seconds after the latest delta", () => {
    const output = new LiveOutputRate(3000)
    output.selectSession("session")
    output.selectMessage("session", "message")
    output.add(delta("x".repeat(40)), 0)
    output.add(delta("x".repeat(40)), 1000)

    expect(output.rate(4000)).toBeCloseTo(10, 5)
    expect(output.rate(4001)).toBe(0)
  })
})

function delta(
  value: string,
  overrides: Partial<{
    sessionID: string
    messageID: string
    partID: string
    field: string
  }> = {},
) {
  return {
    sessionID: overrides.sessionID ?? "session",
    messageID: overrides.messageID ?? "message",
    partID: overrides.partID ?? "part",
    field: overrides.field ?? "text",
    delta: value,
  }
}
