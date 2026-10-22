import { imageInfo } from "@opentui/core"

// The v1 TUI refused inline previews above this many pixels; v2 had no
// equivalent budget before this.
export const MAX_INLINE_SESSION_IMAGE_PIXELS = 4 * 1024 * 1024

// A within-budget image cannot encode to more than ~28 MiB of base64 (RGBA8
// worst case plus the 4/3 encoding overhead), so a longer payload is rejected
// without being decoded here.
const maxEncodedChars = 32 * 1024 * 1024

const base64DataImage = /^data:image\/[^,]*;base64,/i
const dataImage = /^data:image\//i

export type SessionImageProbe =
  | { status: "measured"; width: number; height: number }
  | { status: "unmeasured" }
  | { status: "oversized" }

/**
 * One header parse answers both questions a transcript preview asks: the aspect
 * ratio it sizes itself with, and whether the payload is within the pixel budget.
 * `unmeasured` means the header is unreadable, so the caller falls back to a
 * default ratio and leaves the verdict to the decoder.
 */
export function probeSessionImage(source: string, maxPixels = MAX_INLINE_SESSION_IMAGE_PIXELS): SessionImageProbe {
  const match = base64DataImage.exec(source)
  if (!match) {
    // v1 previewed base64 data images only, and an encoding this probe cannot
    // read is as un-previewable as one the v1 loader rejected outright.
    return dataImage.test(source) ? { status: "oversized" } : { status: "unmeasured" }
  }

  const payload = source.slice(match[0].length)
  if (payload.length > maxEncodedChars) {
    return { status: "oversized" }
  }

  try {
    // imageInfo reads the container header, not the pixels, but it needs the
    // whole payload: a truncated stream fails to parse.
    const info = imageInfo(Buffer.from(payload, "base64"))
    if (info.width <= 0 || info.height <= 0) return { status: "unmeasured" }
    if (info.width > Math.floor(maxPixels / info.height)) return { status: "oversized" }
    return { status: "measured", width: info.width, height: info.height }
  } catch {
    return { status: "unmeasured" }
  }
}

export function inlineImageBudgetExceeded(source: string, maxPixels = MAX_INLINE_SESSION_IMAGE_PIXELS) {
  return probeSessionImage(source, maxPixels).status === "oversized"
}

/**
 * v1 sized a transcript preview by the width it was handed rather than by a fixed
 * tile, and this is that formula: a square cell needs about one row per two
 * columns, so the source aspect is doubled before it becomes a row count.
 */
export function sessionImagePreviewHeight(
  terminalHeight: number,
  availableColumns: number,
  sourceWidth = 16,
  sourceHeight = 9,
  cellAspectRatio = 2,
) {
  const minimum = Math.min(6, Math.max(1, terminalHeight))
  const aspect = sourceWidth > 0 && sourceHeight > 0 ? (sourceWidth / sourceHeight) * cellAspectRatio : 1
  // The width is the authority: the row is as tall as the full width demands. The renderer cannot paint a
  // single tall row, so the preview stacks bands (see session-image-slices); the only remaining bound keeps
  // an absurd aspect ratio from claiming the whole transcript.
  const bound = Math.max(minimum, Math.round(availableColumns * 6))
  return Math.max(minimum, Math.min(bound, Math.round(Math.max(1, availableColumns) / aspect)))
}
