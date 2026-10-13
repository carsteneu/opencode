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

export function inlineImageBudgetExceeded(source: string, maxPixels = MAX_INLINE_SESSION_IMAGE_PIXELS): boolean {
  const match = base64DataImage.exec(source)
  if (!match) {
    // v1 previewed base64 data images only, and an encoding this probe cannot
    // read is as un-previewable as one the v1 loader rejected outright.
    return dataImage.test(source)
  }

  const payload = source.slice(match[0].length)
  if (payload.length > maxEncodedChars) {
    return true
  }

  try {
    // imageInfo reads the container header, not the pixels, but it needs the
    // whole payload: a truncated stream fails to parse.
    const info = imageInfo(Buffer.from(payload, "base64"))
    return info.height > 0 && info.width > Math.floor(maxPixels / info.height)
  } catch {
    return false
  }
}
