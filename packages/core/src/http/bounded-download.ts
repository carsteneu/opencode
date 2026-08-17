import path from "path"
import { Duration, Effect, FileSystem } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { collectBoundedResponseBody } from "../tool/http-body"

export interface BoundedDownloadOptions {
  readonly maxBytes: number
  readonly timeout: Duration.Duration
  readonly allowContentType?: (mime: string) => boolean
}

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

// Fetch an HTTP(S) response with a hard body cap and an optional MIME allowlist. The
// whole fetch (headers + body read) runs under a single total timeout, unlike a bare
// `Effect.timeout` around `http.execute` which would leave the body read unbounded.
export const fetchBoundedBody = (
  http: HttpClient.HttpClient,
  url: string,
  options: BoundedDownloadOptions,
): Effect.Effect<{ body: Buffer; contentType: string }, Error> =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(url).pipe(http.execute, Effect.mapError(toError))
    const contentType = response.headers["content-type"] || ""
    const mime = mimeFrom(contentType)
    if (options.allowContentType && !options.allowContentType(mime)) {
      return yield* Effect.fail(new Error(`Unsupported content type: ${mime}`))
    }
    const body = yield* collectBoundedResponseBody(
      response,
      options.maxBytes,
      () => new Error(`Response too large (exceeds ${options.maxBytes} byte limit)`),
    )
    return { body, contentType }
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(new Error("Request timed out")),
    }),
  )

// Fetch a remote body and decode it as UTF-8 text (for remote instructions etc).
export const fetchBoundedText = (
  http: HttpClient.HttpClient,
  url: string,
  options: BoundedDownloadOptions,
): Effect.Effect<string, Error> =>
  fetchBoundedBody(http, url, options).pipe(Effect.map(({ body }) => new TextDecoder().decode(body)))

// Fetch a body and persist it under `destination`, writing to a same-directory temp
// file first and atomically renaming it into place so a failed/partial download never
// leaves a corrupt target.
export const downloadBounded = (
  fs: FileSystem.FileSystem,
  http: HttpClient.HttpClient,
  url: string,
  destination: string,
  options: BoundedDownloadOptions,
): Effect.Effect<Buffer, Error> =>
  Effect.gen(function* () {
    const { body } = yield* fetchBoundedBody(http, url, options)
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
    const tmp = `${destination}.download-${crypto.randomUUID().slice(0, 8)}`
    yield* fs.writeFile(tmp, new Uint8Array(body))
    yield* fs.rename(tmp, destination)
    return body
  })
