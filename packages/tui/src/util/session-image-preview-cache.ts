import { localImageDataUri } from "./session-image-file"
import { isSessionDataImageUri, loadSessionImageSource, validSessionImageUri } from "./session-image-load"

type Entry = { controller: AbortController; result: Promise<string | undefined>; holders: number }

const entries = new Map<string, Entry>()

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
    return await localImageDataUri(source, signal)
  } catch {
    return undefined
  }
}
