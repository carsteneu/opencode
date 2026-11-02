import { mediaHashFromUri } from "@opencode/client"
import { localImageDataUri, sniffImageMime } from "./session-image-file"
import { isSessionDataImageUri, loadSessionImageSource, validSessionImageUri } from "./session-image-load"

type Entry = { controller: AbortController; result: Promise<string | undefined>; holders: number }

const entries = new Map<string, Entry>()

/**
 * The bytes behind a `media:<hash>` ref. Stored media is only addressable through the client's media cache, which
 * lives in a context, so the client registers this once and every consumer of a preview - transcript, dialog, save -
 * resolves refs through the same cache instead of keeping a second copy of the bytes.
 */
let readStoredMedia: ((source: string) => Promise<Uint8Array>) | undefined

export function setImageMediaReader(read: ((source: string) => Promise<Uint8Array>) | undefined) {
  readStoredMedia = read
}

/**
 * The preview for one markdown source as a data URL, shared by every consumer showing it right now.
 * A source is loaded at most once while it stays on screen and dropped the moment the last consumer
 * releases it, so scrolling a remote image away releases both its bytes and its request.
 */
export function acquireImagePreview(source: string): Promise<string | undefined> {
  const existing = entries.get(source)
  if (existing) {
    existing.holders += 1
    return existing.result
  }
  const controller = new AbortController()
  const entry: Entry = { controller, holders: 1, result: Promise.resolve(undefined) }
  entries.set(source, entry)
  // The abort is re-checked after the load so a release during an in-flight request still resolves as
  // no preview instead of publishing bytes whose consumer is gone.
  entry.result = resolveImagePreview(source, controller.signal).then((uri) =>
    controller.signal.aborted ? undefined : uri,
  )
  return entry.result
}

/** Drop one consumer of a source; the last one to leave aborts the load and forgets the result. */
export function releaseImagePreview(source: string): void {
  const entry = entries.get(source)
  if (!entry) return
  entry.holders -= 1
  if (entry.holders > 0) return
  entry.controller.abort()
  entries.delete(source)
}

/** A source the transcript can render as a preview, whatever it turned out to be. */
async function resolveImagePreview(source: string, signal: AbortSignal) {
  try {
    if (isSessionDataImageUri(source)) return source
    if (validSessionImageUri(source)) return await loadSessionImageSource(source, signal)
    const stored = await storedMediaDataUri(source, signal)
    if (stored) return stored
    return await localImageDataUri(source, signal)
  } catch {
    return undefined
  }
}

/**
 * A stored image as a data URL, so every consumer downstream - the preview cache, the probe, the save dialog - keeps
 * working on the one representation it already understands. A ref whose bytes are gone resolves to nothing, the same
 * way a local file that disappeared does.
 */
async function storedMediaDataUri(source: string, signal: AbortSignal) {
  if (!readStoredMedia || !mediaHashFromUri(source)) return undefined
  const bytes = await readStoredMedia(source)
  if (signal.aborted) return undefined
  const mime = sniffImageMime(bytes)
  if (!mime) return undefined
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

/** The preview for a source without holding it; the save dialog resolves what it is about to write. */
export async function resolveImageToDataUri(source: string): Promise<string | undefined> {
  return resolveImagePreview(source, new AbortController().signal)
}
