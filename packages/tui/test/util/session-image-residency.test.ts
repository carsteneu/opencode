import { describe, expect, test } from "bun:test"
import {
  planSessionImageResidency,
  selectViewportSessionImageKeys,
  SESSION_IMAGE_NATIVE_LIMIT,
  SESSION_IMAGE_NATIVE_RETAIN_VIEWPORTS,
  SESSION_IMAGE_PREFETCH_LIMIT,
  SESSION_IMAGE_PREFETCH_VIEWPORTS,
} from "../../src/util/session-image"

describe("session image residency", () => {
  test("prefetches a bounded band around the viewport", () => {
    const images = Array.from({ length: 12 }, (_, index) => ({
      key: `image-${index}`,
      y: index * 10,
      height: 6,
    }))

    const keys = selectViewportSessionImageKeys(
      images,
      40,
      20,
      SESSION_IMAGE_PREFETCH_LIMIT,
      SESSION_IMAGE_PREFETCH_VIEWPORTS,
    )
    expect(keys.size).toBe(SESSION_IMAGE_PREFETCH_LIMIT)
    expect(keys.has("image-5")).toBeTrue()
    expect(keys.has("image-0")).toBeFalse()
    expect(keys.has("image-10")).toBeFalse()
    expect(SESSION_IMAGE_PREFETCH_LIMIT).toBe(2)
  })

  test("prefetches ahead of an equally near image in the scroll direction", () => {
    const images = [
      { key: "above", y: -10, height: 5 },
      { key: "visible", y: 5, height: 10 },
      { key: "below", y: 25, height: 5 },
    ]

    expect([...selectViewportSessionImageKeys(images, 0, 20, 2, 1, 1)]).toEqual(["visible", "below"])
    expect([...selectViewportSessionImageKeys(images, 0, 20, 2, 1, -1)]).toEqual(["visible", "above"])
  })

  test("cold-acquires only visible native images", () => {
    const images = [
      { key: "above", y: -10, height: 5 },
      { key: "visible", y: 5, height: 10 },
      { key: "below", y: 25, height: 5 },
    ]

    expect([...planSessionImageResidency(images, 0, 20, new Set())]).toEqual(["visible"])
  })

  test("does not cold-acquire images that only touch a viewport boundary", () => {
    const images = [
      { key: "above", y: -5, height: 5 },
      { key: "inside", y: 5, height: 10 },
      { key: "below", y: 20, height: 5 },
    ]

    expect([...planSessionImageResidency(images, 0, 20, new Set(), { direction: 1 })]).toEqual(["inside"])
  })

  test("retains an existing native image across the eviction band", () => {
    const images = [
      { key: "near", y: -10, height: 5 },
      { key: "visible", y: 5, height: 10 },
    ]
    const previous = new Set(["near", "visible"])

    expect([...planSessionImageResidency(images, 0, 20, previous)]).toEqual(["visible", "near"])
    expect([...planSessionImageResidency(images, 0, 20, new Set())]).toEqual(["visible"])
    expect(
      planSessionImageResidency(
        [
          { key: "near", y: -22, height: 5 },
          { key: "visible", y: 5, height: 10 },
        ],
        0,
        20,
        previous,
      ).has("near"),
    ).toBeFalse()
  })

  test("keeps the visible image and prefers the scroll direction under pressure", () => {
    const images = [
      { key: "above", y: -10, height: 5 },
      { key: "visible", y: 5, height: 10 },
      { key: "below", y: 25, height: 5 },
    ]
    const previous = new Set(images.map((image) => image.key))

    expect([...planSessionImageResidency(images, 0, 20, previous, { direction: 1 })]).toEqual(["visible", "below"])
    expect([...planSessionImageResidency(images, 0, 20, previous, { direction: -1 })]).toEqual(["visible", "above"])
    expect(planSessionImageResidency(images, 0, 20, previous).size).toBe(SESSION_IMAGE_NATIVE_LIMIT)
  })

  test("uses scroll direction for equally ranked visible cold candidates", () => {
    const images = [
      { key: "above", y: 0, height: 4 },
      { key: "center", y: 8, height: 4 },
      { key: "below", y: 16, height: 4 },
    ]

    expect([...planSessionImageResidency(images, 0, 20, new Set(), { direction: 1 })]).toEqual(["center", "below"])
    expect([...planSessionImageResidency(images, 0, 20, new Set(), { direction: -1 })]).toEqual(["center", "above"])
  })

  test("keeps residents stable through one-row viewport jitter", () => {
    const images = [
      { key: "above", y: 0, height: 4 },
      { key: "center", y: 8, height: 4 },
      { key: "below", y: 16, height: 4 },
    ]
    const residents = new Set(["center", "above"])

    const down = planSessionImageResidency(images, 1, 20, residents, { direction: 1 })
    const up = planSessionImageResidency(images, -1, 20, down, { direction: -1 })

    expect([...down]).toEqual(["center", "above"])
    expect([...up]).toEqual(["center", "above"])
  })

  test("hands residency forward after movement clears the hysteresis threshold", () => {
    const images = [
      { key: "above", y: 0, height: 4 },
      { key: "center", y: 8, height: 4 },
      { key: "below", y: 16, height: 4 },
    ]
    const residents = new Set(["center", "above"])

    expect([...planSessionImageResidency(images, 2, 20, residents, { direction: 1 })]).toEqual(["center", "below"])
  })

  test("bounds native residency with many visible history images", () => {
    const images = Array.from({ length: 10 }, (_, index) => ({
      key: `image-${index}`,
      y: index * 3,
      height: 3,
    }))
    const residents = planSessionImageResidency(images, 0, 30, new Set(), { direction: 1, limit: 10 })

    expect(residents.size).toBe(SESSION_IMAGE_NATIVE_LIMIT)
    expect([...residents].every((key) => images.find((image) => image.key === key)!.y < 30)).toBeTrue()
  })

  test("preserves overlapping residents while the viewport advances", () => {
    const images = [
      { key: "a", y: 0, height: 15 },
      { key: "b", y: 20, height: 15 },
      { key: "c", y: 40, height: 15 },
    ]
    const first = planSessionImageResidency(images, 0, 30, new Set())
    const second = planSessionImageResidency(images, 20, 30, first, { direction: 1 })

    expect([...first]).toEqual(["a", "b"])
    expect([...second]).toEqual(["b", "c"])
    expect(second.size).toBeLessThanOrEqual(SESSION_IMAGE_NATIVE_LIMIT)
    expect(SESSION_IMAGE_NATIVE_RETAIN_VIEWPORTS).toBeGreaterThan(0)
  })
})
