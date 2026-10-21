export * as Media from "./media.js"

import { Effect, FileSystem, Schema, SchemaGetter, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClientRequest } from "effect/http"
import { ProviderID } from "./schema/ids.js"
import { AIError, InvalidProviderOutputError, InvalidRequestError } from "./schema/errors.js"
import { ProviderMetadata } from "./schema/options.js"
import { responseHttp, Service } from "./route/executor-service.js"
import { detectMediaType, fileMediaType } from "./utils/media-type.js"

export { detectMediaType } from "./utils/media-type.js"

const OCTET_STREAM = "application/octet-stream"

/**
 * Cap for a downloaded image asset. Image payloads are the one kind the TUI previews eagerly and their URLs are
 * provider-supplied, so an unbounded read would let a hostile or misconfigured origin exhaust memory. The kind comes
 * from the declared media type, which image protocols frequently omit (`Media.url(sample)`), so a response that
 * declares an image content type is capped too. Every other download keeps today's unbounded read: those are
 * user-driven and may legitimately be large.
 */
export const MAX_IMAGE_DOWNLOAD_BYTES = 32 * 1024 * 1024

// ---------------------------------------------------------------------------
// Source — the serializable wire/persistence form of a media asset
// ---------------------------------------------------------------------------

const BytesSource = Schema.Struct({
  type: Schema.Literal("bytes"),
  data: Schema.Uint8Array,
  mediaType: Schema.String,
})

const Base64Source = Schema.Struct({
  type: Schema.Literal("base64"),
  data: Schema.String,
  mediaType: Schema.String,
})

const UrlSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optional(Schema.String),
  /** Epoch milliseconds after which the provider no longer serves the URL. */
  expiresAt: Schema.optional(Schema.Number),
})

/** A provider-side handle: OpenAI `file_id`, Gemini file URI, `gs://`, `runway://`, or a prior generation id. */
const RefSource = Schema.Struct({
  type: Schema.Literal("ref"),
  provider: ProviderID,
  id: Schema.String,
  mediaType: Schema.optional(Schema.String),
})

export const Source = Schema.Union([BytesSource, Base64Source, UrlSource, RefSource])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Media.Source" })
export type Source = Schema.Schema.Type<typeof Source>

// ---------------------------------------------------------------------------
// Kind, Info, Notice
// ---------------------------------------------------------------------------

export type AspectRatio = `${number}:${number}`
export const AspectRatio = Schema.declare<AspectRatio>(
  (value): value is AspectRatio => typeof value === "string" && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value),
  { title: "Media.AspectRatio" },
)

export const Kind = Schema.Literals(["image", "video", "audio", "document", "other"])
export type Kind = Schema.Schema.Type<typeof Kind>

/**
 * Office and OpenDocument media types. Unlike images and PDFs their leading bytes are a generic zip or OLE container,
 * so nothing can sniff them; the declared type is the only carrier. They lower to a provider-side file part like a PDF.
 */
const OFFICE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])

export const isOfficeMediaType = (mediaType: string) => OFFICE_MEDIA_TYPES.has(mediaType.toLowerCase())

export const kindOf = (mediaType: string): Kind => {
  const lower = mediaType.toLowerCase()
  if (lower.startsWith("image/")) return "image"
  if (lower.startsWith("video/")) return "video"
  if (lower.startsWith("audio/")) return "audio"
  if (lower === "application/pdf" || lower.startsWith("text/") || isOfficeMediaType(lower)) return "document"
  return "other"
}

/** Container-independent facts about the payload; raw PCM audio relies on these because it has no header. */
export const Info = Schema.Struct({
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  sampleRate: Schema.optional(Schema.Number),
  channels: Schema.optional(Schema.Number),
  encoding: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
}).annotate({ identifier: "Media.Info" })
export type Info = Schema.Schema.Type<typeof Info>

/** A provider-side partial result such as stripped audio or a moderated sample; never a silent drop. */
export const Notice = Schema.Struct({
  type: Schema.Literals(["moderated", "filtered", "other"]),
  message: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "Media.Notice" })
export type Notice = Schema.Schema.Type<typeof Notice>

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

const invalid = (message: string, cause?: unknown) =>
  new AIError({ reason: new InvalidRequestError({ message, cause }) })

/** Synchronous view of an inline payload; `undefined` for `url` and `ref` sources, which carry no local bytes. */
export interface Inline {
  readonly mime: string
  readonly base64: string
  readonly dataUrl: string
}

export class Asset {
  readonly source: Source
  /** Derived from the source: declared type, sniffed magic bytes, then `application/octet-stream`. */
  readonly mediaType: string
  readonly kind: Kind
  readonly info?: Info
  /** Epoch milliseconds after which a `url` source stops resolving. */
  readonly expiresAt?: number
  readonly providerMetadata?: ProviderMetadata
  /** Transient download credentials for `url` sources; see `Asset.Input.headers`. */
  readonly headers?: Record<string, string>

  // Derived payload forms are cached on the instance because every protocol lowering re-reads the same payload. The
  // cache is check-then-set (concurrent first reads of a `url` source may both download) and is never observable
  // through `source`, so round-tripping through `Media.from(asset.source)` stays lossless.
  #bytes: Uint8Array | undefined
  #base64: string | undefined

  constructor(input: Asset.Input) {
    this.source = input.source
    this.mediaType =
      input.source.mediaType ??
      (input.source.type === "bytes" ? detectMediaType(input.source.data) : undefined) ??
      OCTET_STREAM
    this.kind = kindOf(this.mediaType)
    this.info = input.info
    this.expiresAt = input.source.type === "url" ? input.source.expiresAt : undefined
    this.providerMetadata = input.providerMetadata
    this.headers = input.source.type === "url" ? input.headers : undefined
  }

  /** Inline payload without effects, for protocols that embed base64 or data URLs directly. */
  inline(): Inline | undefined {
    const source = this.source
    if (source.type !== "bytes" && source.type !== "base64") return undefined
    const base64 = source.type === "base64" ? source.data : (this.#base64 ??= Base64.encode(source.data))
    const mime = this.mediaType.toLowerCase()
    return { mime, base64, dataUrl: `data:${mime};base64,${base64}` }
  }

  /** Decoded payload; downloads `url` sources through the request executor and caches the result. */
  bytes(): Effect.Effect<Uint8Array, AIError, Service> {
    return Effect.suspend(() => {
      const source = this.source
      if (source.type === "bytes") return Effect.succeed(source.data)
      if (this.#bytes !== undefined) return Effect.succeed(this.#bytes)
      if (source.type === "ref")
        return Effect.fail(invalid(`Cannot materialize provider ref ${source.provider}:${source.id}`))
      const decoded =
        source.type === "base64"
          ? Effect.fromResult(Base64.decode(source.data)).pipe(
              Effect.mapError((cause) => invalid(`Media asset contains invalid base64 data`, cause)),
            )
          : download(source, this.headers, this.kind === "image" ? MAX_IMAGE_DOWNLOAD_BYTES : undefined)
      return decoded.pipe(Effect.tap((data) => Effect.sync(() => (this.#bytes = data))))
    })
  }

  base64(): Effect.Effect<string, AIError, Service> {
    return Effect.suspend(() => {
      const source = this.source
      if (source.type === "base64") return Effect.succeed(source.data)
      if (this.#base64 !== undefined) return Effect.succeed(this.#base64)
      return this.bytes().pipe(Effect.map((data) => (this.#base64 = Base64.encode(data))))
    })
  }

  dataUrl(): Effect.Effect<string, AIError, Service> {
    return this.base64().pipe(Effect.map((data) => `data:${this.mediaType};base64,${data}`))
  }

  /**
   * The `AssetEncoded` JSON form with `bytes` sources as base64, matching `Schema.toCodecJson(AssetSchema)`, so a
   * plain `JSON.stringify` of messages or events stays lossless and decodes back through the JSON codec.
   */
  toJSON() {
    const source = this.source
    return {
      source: source.type === "bytes" ? { ...source, data: Base64.encode(source.data) } : source,
      info: this.info,
      providerMetadata: this.providerMetadata,
    }
  }

  /** Pull `url` sources into owned bytes before the URL expires. Inline sources return themselves. */
  materialize(): Effect.Effect<Asset, AIError, Service> {
    if (this.source.type === "bytes" || this.source.type === "base64") return Effect.succeed(this)
    return this.bytes().pipe(
      Effect.map((data) =>
        bytes(data, this.source.mediaType, { info: this.info, providerMetadata: this.providerMetadata }),
      ),
    )
  }
}

export namespace Asset {
  export interface Input {
    readonly source: Source
    readonly info?: Info
    readonly providerMetadata?: ProviderMetadata
    /**
     * Headers required to download a `url` source, such as the provider API key Veo demands for its file URIs.
     * They are runtime-only: never part of `source`, `toJSON()`, or `AssetSchema`, so a persisted asset cannot leak
     * credentials and cannot be downloaded again after a round-trip. Call `materialize()` before persisting.
     */
    readonly headers?: Record<string, string>
  }
}

/** JSON form of an asset: the serializable `Source` plus caller-supplied metadata. `bytes` sources encode as base64. */
export const AssetEncoded = Schema.Struct({
  source: Source,
  info: Schema.optional(Info),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "Media.AssetEncoded" })

const encodeAsset = (asset: Asset): typeof AssetEncoded.Type => ({
  source: asset.source,
  info: asset.info,
  providerMetadata: asset.providerMetadata,
})

const AssetInstance = Schema.declare((value): value is Asset => value instanceof Asset, {
  expected: "Media.Asset",
})

/** `Asset` in the type domain and `AssetEncoded` on the wire, so messages and events holding assets serialize. */
export const AssetSchema = AssetEncoded.pipe(
  Schema.decodeTo(AssetInstance, {
    decode: SchemaGetter.transform((encoded) => new Asset(encoded)),
    encode: SchemaGetter.transform(encodeAsset),
  }),
)

const download = Effect.fn("Media.download")(function* (
  source: Extract<Source, { readonly type: "url" }>,
  headers: Record<string, string> | undefined,
  limit?: number,
) {
  const executor = yield* Service
  const response = yield* executor.execute(
    HttpClientRequest.get(source.url).pipe(HttpClientRequest.setHeaders(headers ?? {})),
  )
  const http = responseHttp(response)
  const failure = (cause: unknown) =>
    new AIError({
      reason: new InvalidProviderOutputError({ message: `Failed to read media from ${source.url}`, http, cause }),
    })
  const capped = limit ?? (declaresImage(response.headers) ? MAX_IMAGE_DOWNLOAD_BYTES : undefined)
  // Only the capped read streams. Unbounded downloads keep `arrayBuffer` so their allocation pattern is unchanged.
  if (capped === undefined) return new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(failure)))
  return yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
      (acc, chunk) => {
        const bytes = acc.bytes + chunk.byteLength
        if (bytes > capped)
          return Effect.fail(
            new AIError({
              reason: new InvalidProviderOutputError({
                message: `Media image from ${source.url} exceeds the ${capped} byte limit`,
                http,
              }),
            }),
          )
        acc.chunks.push(chunk)
        acc.bytes = bytes
        return Effect.succeed(acc)
      },
    ),
    Effect.map((acc) => {
      const data = new Uint8Array(acc.bytes)
      let offset = 0
      for (const chunk of acc.chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
      return data
    }),
    Effect.mapError((error) => (error instanceof AIError ? error : failure(error))),
  )
})

/** Response header names arrive in their original case, so compare the only header that matters here case-insensitively. */
const declaresImage = (headers: Record<string, string>) =>
  Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === "content-type" && value.trim().toLowerCase().startsWith("image/"),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export type AssetOptions = Omit<Asset.Input, "source">

export const from = (source: Source, options?: AssetOptions) => new Asset({ ...options, source })

export const bytes = (data: Uint8Array, mediaType?: string, options?: AssetOptions) =>
  from({ type: "bytes", data, mediaType: mediaType ?? detectMediaType(data) ?? OCTET_STREAM }, options)

export const base64 = (data: string, mediaType: string, options?: AssetOptions) =>
  from({ type: "base64", data, mediaType }, options)

export const url = (
  value: string,
  options?: AssetOptions & Omit<Extract<Source, { readonly type: "url" }>, "type" | "url">,
) => {
  const { mediaType, expiresAt, ...rest } = options ?? {}
  return from({ type: "url", url: value, mediaType, expiresAt }, rest)
}

export const ref = (provider: string | ProviderID, id: string, mediaType?: string, options?: AssetOptions) =>
  from({ type: "ref", provider: ProviderID.make(provider), id, mediaType }, options)

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s

/** Parse a `data:<mime>;base64,<data>` URL, or `undefined` when the value is not a base64 data URL. */
export const parseDataUrl = (value: string, options?: AssetOptions) => {
  const match = DATA_URL.exec(value)
  return match === null ? undefined : base64(match[2], match[1], options)
}

/** Parse a `data:<mime>;base64,<data>` URL. Malformed input throws a typed `AIError` because constructors are sync. */
export const fromDataUrl = (dataUrl: string, options?: AssetOptions) => {
  const asset = parseDataUrl(dataUrl, options)
  if (asset === undefined) throw invalid("Media data URLs must contain a MIME type and base64 data")
  return asset
}

/** Read a file through `FileSystem` and sniff its media type from magic bytes, then the extension. */
export const file = (path: string, options?: AssetOptions): Effect.Effect<Asset, AIError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const data = yield* fs
      .readFile(path)
      .pipe(Effect.mapError((cause) => invalid(`Failed to read media file ${path}`, cause)))
    return bytes(data, fileMediaType(data, path), options)
  })

/** Materialize an asset and write its bytes through `FileSystem`. */
export const write = (asset: Asset, path: string): Effect.Effect<void, AIError, FileSystem.FileSystem | Service> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const data = yield* asset.bytes()
    yield* fs
      .writeFile(path, data)
      .pipe(Effect.mapError((cause) => invalid(`Failed to write media file ${path}`, cause)))
  })
