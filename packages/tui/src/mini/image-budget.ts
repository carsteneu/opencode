import { imageInfo } from "@opentui/core"

// Matches the v1 inline transcript budget (`routes/session/index.tsx`).
export const MAX_INLINE_SESSION_IMAGE_PIXELS = 4 * 1024 * 1024

const dataImagePrefix = /^data:image\/[a-z0-9.+-]+;base64,/i

// Dimensions live in the encoded header, so an oversized image is rejected
// before the decoder allocates its pixel buffer.
export function inlineImageBudgetExceeded(source: string, maxPixels = MAX_INLINE_SESSION_IMAGE_PIXELS): boolean {
  if (!dataImagePrefix.test(source)) {
    return false
  }

  try {
    const info = imageInfo(Buffer.from(source.slice(source.indexOf(",") + 1), "base64"))
    return info.height > 0 && info.width > Math.floor(maxPixels / info.height)
  } catch {
    return false
  }
}
