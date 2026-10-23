import { describe, expect, test } from "bun:test"
import { intersectsViewport, visibilityMargin } from "../../src/util/session-image-visibility"

describe("intersectsViewport", () => {
  test("a row inside the viewport intersects", () => {
    expect(intersectsViewport(5, 10, 30, 0)).toBe(true)
  })

  test("a row fully above or below does not, until the margin reaches it", () => {
    expect(intersectsViewport(-20, 10, 30, 0)).toBe(false)
    expect(intersectsViewport(-20, 10, 30, 10)).toBe(true)
    expect(intersectsViewport(35, 10, 30, 0)).toBe(false)
    expect(intersectsViewport(35, 10, 30, 5)).toBe(true)
  })

  test("a row taller than the viewport still intersects", () => {
    expect(intersectsViewport(-100, 400, 30, 0)).toBe(true)
  })

  test("an unmeasured viewport intersects nothing", () => {
    expect(intersectsViewport(0, 10, 0, 100)).toBe(false)
  })
})

describe("visibilityMargin", () => {
  test("a shown row keeps a wider margin than a hidden one needs to come back", () => {
    expect(visibilityMargin(true, 30)).toBe(60)
    expect(visibilityMargin(false, 30)).toBe(30)
    // The gap between the two is the hysteresis: a row just past the enter margin stays hidden.
    expect(visibilityMargin(true, 30)).toBeGreaterThan(visibilityMargin(false, 30))
  })
})
