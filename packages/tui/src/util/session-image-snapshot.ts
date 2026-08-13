import type { NativeImage } from "@opentui/core"

export const SESSION_IMAGE_SNAPSHOT_MAX_COUNT = 64
export const SESSION_IMAGE_SNAPSHOT_MAX_WIDTH = 160
export const SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT = 48
export const SESSION_IMAGE_SNAPSHOT_MAX_CELLS = 8_192
export const SESSION_IMAGE_SNAPSHOT_TOTAL_CELLS = 327_680

export type SessionImageSnapshot = {
  key: string
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
  pixels: Uint8Array
}

export function captureSessionImageSnapshot(
  key: string,
  image: NativeImage,
  input: {
    availableWidth: number
    availableHeight: number
    cellAspectRatio?: number
  },
): SessionImageSnapshot {
  if (!key) throw new Error("Image snapshot key must not be empty")
  const availableWidth = boundedInteger(input.availableWidth, SESSION_IMAGE_SNAPSHOT_MAX_WIDTH)
  const availableHeight = boundedInteger(input.availableHeight, SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT)
  const cellAspectRatio =
    input.cellAspectRatio !== undefined && Number.isFinite(input.cellAspectRatio) && input.cellAspectRatio > 0
      ? input.cellAspectRatio
      : 2
  const displayAspect = (image.width / image.height) * cellAspectRatio
  const fitScale = Math.min(availableWidth / displayAspect, availableHeight)
  const initialWidth = Math.max(1, Math.min(availableWidth, Math.round(displayAspect * fitScale)))
  const initialHeight = Math.max(1, Math.min(availableHeight, Math.round(fitScale)))
  const budgetScale = Math.min(1, Math.sqrt(SESSION_IMAGE_SNAPSHOT_MAX_CELLS / (initialWidth * initialHeight)))
  const width = Math.max(1, Math.floor(initialWidth * budgetScale))
  const height = Math.max(
    1,
    Math.min(Math.floor(initialHeight * budgetScale), Math.floor(SESSION_IMAGE_SNAPSHOT_MAX_CELLS / width)),
  )
  const resized = image.resize({ width: width * 2, height: height * 2, kernel: "area" })

  try {
    const raw = resized.raw()
    return {
      key,
      width,
      height,
      pixelWidth: raw.width,
      pixelHeight: raw.height,
      pixels: raw.data,
    }
  } finally {
    resized.dispose()
  }
}

export class SessionImageSnapshotStore {
  private snapshots = new Map<string, SessionImageSnapshot>()
  private cells = 0
  private disposed = false

  public get size() {
    return this.snapshots.size
  }

  public get totalCells() {
    return this.cells
  }

  public get(key: string) {
    if (this.disposed) return undefined
    return this.snapshots.get(key)
  }

  public touch(key: string) {
    const snapshot = this.get(key)
    if (!snapshot) return undefined
    this.snapshots.delete(key)
    this.snapshots.set(key, snapshot)
    return snapshot
  }

  public put(snapshot: SessionImageSnapshot) {
    if (this.disposed) throw new Error("Image snapshot store is disposed")
    validateSnapshot(snapshot)

    const previous = this.snapshots.get(snapshot.key)
    if (previous) {
      this.snapshots.delete(snapshot.key)
      this.cells -= previous.width * previous.height
    }

    const evicted: string[] = []
    const cells = snapshot.width * snapshot.height
    while (
      this.snapshots.size >= SESSION_IMAGE_SNAPSHOT_MAX_COUNT ||
      this.cells + cells > SESSION_IMAGE_SNAPSHOT_TOTAL_CELLS
    ) {
      const oldest = this.snapshots.entries().next().value
      if (!oldest) break
      this.snapshots.delete(oldest[0])
      this.cells -= oldest[1].width * oldest[1].height
      evicted.push(oldest[0])
    }

    this.snapshots.set(snapshot.key, snapshot)
    this.cells += cells
    return evicted
  }

  public retain(keys: ReadonlySet<string>) {
    const evicted = [...this.snapshots]
      .filter(([key]) => !keys.has(key))
      .map(([key, snapshot]) => {
        this.snapshots.delete(key)
        this.cells -= snapshot.width * snapshot.height
        return key
      })
    return evicted
  }

  public clear() {
    if (this.disposed) return
    this.snapshots.clear()
    this.cells = 0
  }

  public dispose() {
    if (this.disposed) return
    this.disposed = true
    this.snapshots.clear()
    this.cells = 0
  }
}

function boundedInteger(value: number, maximum: number) {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.max(1, Math.min(maximum, Math.floor(value)))
}

function validateSnapshot(snapshot: SessionImageSnapshot) {
  if (!snapshot.key) throw new Error("Image snapshot key must not be empty")
  if (
    !Number.isSafeInteger(snapshot.width) ||
    snapshot.width <= 0 ||
    snapshot.width > SESSION_IMAGE_SNAPSHOT_MAX_WIDTH
  ) {
    throw new Error("Image snapshot width exceeds its budget")
  }
  if (
    !Number.isSafeInteger(snapshot.height) ||
    snapshot.height <= 0 ||
    snapshot.height > SESSION_IMAGE_SNAPSHOT_MAX_HEIGHT ||
    snapshot.width * snapshot.height > SESSION_IMAGE_SNAPSHOT_MAX_CELLS
  ) {
    throw new Error("Image snapshot height exceeds its budget")
  }
  if (snapshot.pixelWidth !== snapshot.width * 2 || snapshot.pixelHeight !== snapshot.height * 2) {
    throw new Error("Image snapshot pixels must use a 2x2 sample per terminal cell")
  }
  if (snapshot.pixels.byteLength !== snapshot.pixelWidth * snapshot.pixelHeight * 4) {
    throw new Error("Image snapshot pixel buffer has an invalid length")
  }
}
