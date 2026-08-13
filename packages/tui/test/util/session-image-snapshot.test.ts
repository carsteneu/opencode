import { describe, expect, test } from "bun:test"
import { NativeImage } from "@opentui/core"
import {
  captureSessionImageSnapshot,
  SESSION_IMAGE_SNAPSHOT_MAX_CELLS,
  SESSION_IMAGE_SNAPSHOT_MAX_COUNT,
  SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT,
  SESSION_IMAGE_SNAPSHOT_MAX_WIDTH,
  SESSION_IMAGE_SNAPSHOT_TOTAL_CELLS,
  SessionImageSnapshotStore,
  type SessionImageSnapshot,
} from "../../src/util/session-image-snapshot"

describe("session image snapshots", () => {
  test("captures a full-width bounded raster without disposing the source image", () => {
    const image = NativeImage.fromRgba(new Uint8Array(16 * 9 * 4).fill(255), 16, 9)

    try {
      const snapshot = captureSessionImageSnapshot("image", image, {
        availableWidth: 240,
        availableHeight: 80,
        cellAspectRatio: 2,
      })

      expect(snapshot.width).toBe(SESSION_IMAGE_SNAPSHOT_MAX_WIDTH)
      expect(snapshot.height).toBe(45)
      expect(snapshot.width * snapshot.height).toBeLessThanOrEqual(SESSION_IMAGE_SNAPSHOT_MAX_CELLS)
      expect(snapshot.pixelWidth).toBe(snapshot.width * 2)
      expect(snapshot.pixelHeight).toBe(snapshot.height * 2)
      expect(snapshot.pixels.byteLength).toBe(snapshot.pixelWidth * snapshot.pixelHeight * 4)
      expect(image.width).toBe(16)
      expect(image.height).toBe(9)
    } finally {
      image.dispose()
    }
  })

  test("caps portrait snapshots by dimensions and cell budget", () => {
    const image = NativeImage.fromRgba(new Uint8Array(2 * 20 * 4).fill(255), 2, 20)

    try {
      const snapshot = captureSessionImageSnapshot("portrait", image, {
        availableWidth: 1_000,
        availableHeight: 1_000,
      })

      expect(snapshot.width).toBeLessThanOrEqual(SESSION_IMAGE_SNAPSHOT_MAX_WIDTH)
      expect(snapshot.height).toBeLessThanOrEqual(SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT)
      expect(snapshot.width * snapshot.height).toBeLessThanOrEqual(SESSION_IMAGE_SNAPSHOT_MAX_CELLS)
    } finally {
      image.dispose()
    }
  })

  test("evicts by LRU count, prunes absent keys, and disposes idempotently", () => {
    const store = new SessionImageSnapshotStore()
    Array.from({ length: SESSION_IMAGE_SNAPSHOT_MAX_COUNT }, (_, index) => snapshot(`image-${index}`)).forEach(
      (image) => store.put(image),
    )
    expect(store.touch("image-0")?.key).toBe("image-0")

    expect(store.put(snapshot("image-new"))).toEqual(["image-1"])
    expect(store.size).toBe(SESSION_IMAGE_SNAPSHOT_MAX_COUNT)
    expect(store.get("image-1")).toBeUndefined()
    expect(store.retain(new Set(["image-0", "image-new"]))).toHaveLength(SESSION_IMAGE_SNAPSHOT_MAX_COUNT - 2)
    expect(store.size).toBe(2)
    expect(store.totalCells).toBe(2)
    store.clear()
    expect(store.size).toBe(0)
    expect(store.totalCells).toBe(0)

    store.dispose()
    store.dispose()
    expect(store.size).toBe(0)
    expect(store.totalCells).toBe(0)
    expect(() => store.put(snapshot("late"))).toThrow("Image snapshot store is disposed")
  })

  test("rejects snapshots that bypass a hard dimension or buffer budget", () => {
    const store = new SessionImageSnapshotStore()
    const oversized = snapshot("oversized", SESSION_IMAGE_SNAPSHOT_MAX_WIDTH + 1, 1)
    expect(() => store.put(oversized)).toThrow("Image snapshot width exceeds its budget")

    const malformed = { ...snapshot("malformed"), pixels: new Uint8Array() }
    expect(() => store.put(malformed)).toThrow("Image snapshot pixel buffer has an invalid length")
    store.dispose()
  })

  test("evicts old snapshots before exceeding the aggregate cell budget", () => {
    const store = new SessionImageSnapshotStore()
    const width = SESSION_IMAGE_SNAPSHOT_MAX_WIDTH
    const height = SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT
    const count = Math.floor(SESSION_IMAGE_SNAPSHOT_TOTAL_CELLS / (width * height)) + 1

    Array.from({ length: count }, (_, index) => snapshot(`large-${index}`, width, height)).forEach((image) =>
      store.put(image),
    )

    expect(store.size).toBeLessThan(count)
    expect(store.totalCells).toBeLessThanOrEqual(SESSION_IMAGE_SNAPSHOT_TOTAL_CELLS)
    store.dispose()
  })
})

function snapshot(key: string, width = 1, height = 1): SessionImageSnapshot {
  return {
    key,
    width,
    height,
    pixelWidth: width * 2,
    pixelHeight: height * 2,
    pixels: new Uint8Array(width * height * 16),
  }
}
