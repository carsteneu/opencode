import { describe, expect, test } from "bun:test"
import { TokenRateMeter } from "../../src/util/token-rate"

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
