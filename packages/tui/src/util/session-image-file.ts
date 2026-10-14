import { readFile, stat } from "node:fs/promises"

// A preview is refused above this size instead of being read into memory. The inline budget caps a
// previewable image at 4 Mi px, which is 16 MiB even in an uncompressed container at 4 bytes per
// pixel, so a larger local file cannot be one this transcript would have drawn.
export const MAX_LOCAL_IMAGE_BYTES = 16 * 1024 * 1024

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The container the bytes actually are, not the one the filename or the response header claims. Only
 * the formats the preview can decode are reported, so a text file named `.png` is refused rather than
 * handed to the decoder to fail on.
 */
export function sniffImageMime(bytes: Uint8Array) {
  if (bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte)) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return undefined
}

/** A local file as a base64 data URL, or undefined when it is unreadable, oversized, or not an image. */
export async function localImageDataUri(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    signal?.throwIfAborted()
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_LOCAL_IMAGE_BYTES) return
    const bytes = await readFile(path)
    signal?.throwIfAborted()
    // Checked again on what was read: the file can grow between the stat and the read, and the cap is
    // the whole reason the bytes may be held.
    if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) return
    const mime = sniffImageMime(bytes)
    if (!mime) return
    return `data:${mime};base64,${bytes.toString("base64")}`
  } catch {
    return undefined
  }
}
