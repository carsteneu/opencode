import { Effect, Schema } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import {
  GeneratedImage,
  ImageModel,
  ImageResponse,
  type ImageModelDefaults,
  type ImageRequest,
  type ImageRoute,
} from "../image"
import { Auth, type Definition as AuthDefinition } from "../route/auth"
import {
  InvalidProviderOutputReason,
  LLMError,
  UnknownProviderReason,
  Usage,
  mergeHttpOptions,
  mergeJsonRecords,
} from "../schema"
import { ProviderShared } from "./shared"

const ADAPTER = "alibaba-images"
export const DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com/api/v1"
export const PATH = "/services/aigc/multimodal-generation/generation"

export type Family = "qwen" | "wan"

export interface QwenImageOptions extends Record<string, unknown> {
  readonly negativePrompt?: string
  readonly promptExtend?: boolean
  readonly watermark?: boolean
}

export interface WanColor {
  readonly hex: string
  readonly ratio: string
}

export interface WanImageOptions extends Record<string, unknown> {
  readonly resolution?: "1K" | "2K" | "4K"
  readonly thinkingMode?: boolean
  readonly colorPalette?: ReadonlyArray<WanColor>
  readonly watermark?: boolean
}

export interface AlibabaImageOptions extends Record<string, unknown> {
  readonly qwen?: QwenImageOptions
  readonly wan?: WanImageOptions
}

declare module "../image" {
  interface ImageProviderOptions {
    readonly alibaba?: AlibabaImageOptions
  }
}

const MessageInput = Schema.Struct({
  messages: Schema.Tuple([
    Schema.Struct({
      role: Schema.tag("user"),
      content: Schema.Tuple([Schema.Struct({ text: Schema.String })]),
    }),
  ]),
})

const QwenBody = Schema.Struct({
  model: Schema.String,
  input: MessageInput,
  parameters: Schema.Struct({
    size: Schema.optional(Schema.String),
    n: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    negative_prompt: Schema.optional(Schema.String),
    prompt_extend: Schema.optional(Schema.Boolean),
    watermark: Schema.optional(Schema.Boolean),
    seed: Schema.optional(Schema.Int),
  }),
})
export type QwenBody = Schema.Schema.Type<typeof QwenBody>

const WanBody = Schema.Struct({
  model: Schema.String,
  input: MessageInput,
  parameters: Schema.Struct({
    size: Schema.optional(Schema.String),
    n: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    thinking_mode: Schema.optional(Schema.Boolean),
    color_palette: Schema.optional(
      Schema.Array(
        Schema.Struct({
          hex: Schema.String,
          ratio: Schema.String,
        }),
      ),
    ),
    watermark: Schema.optional(Schema.Boolean),
    seed: Schema.optional(Schema.Int),
  }),
})
export type WanBody = Schema.Schema.Type<typeof WanBody>

const AlibabaResponse = Schema.Struct({
  output: Schema.optional(
    Schema.Struct({
      choices: Schema.Array(
        Schema.Struct({
          finish_reason: Schema.optional(Schema.String),
          message: Schema.Struct({
            role: Schema.optional(Schema.String),
            content: Schema.Array(
              Schema.Struct({
                image: Schema.String,
                type: Schema.optional(Schema.String),
              }),
            ),
          }),
        }),
      ),
      finished: Schema.optional(Schema.Boolean),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      image_count: Schema.optional(Schema.Number),
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
      total_tokens: Schema.optional(Schema.Number),
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
      size: Schema.optional(Schema.String),
    }),
  ),
  request_id: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})

export interface ModelInput {
  readonly id: string
  readonly family: Family
  readonly auth: AuthDefinition
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  readonly defaults?: ImageModelDefaults
}

const options = (request: ImageRequest): AlibabaImageOptions => ({
  ...request.model.defaults?.providerOptions?.alibaba,
  ...request.providerOptions?.alibaba,
  qwen: {
    ...(request.model.defaults?.providerOptions?.alibaba?.qwen as QwenImageOptions | undefined),
    ...(request.providerOptions?.alibaba?.qwen as QwenImageOptions | undefined),
  },
  wan: {
    ...(request.model.defaults?.providerOptions?.alibaba?.wan as WanImageOptions | undefined),
    ...(request.providerOptions?.alibaba?.wan as WanImageOptions | undefined),
  },
})

const messageInput = (request: ImageRequest) => ({
  messages: [{ role: "user" as const, content: [{ text: request.prompt }] }] as const,
})

const qwenBody = (request: ImageRequest): QwenBody => {
  const qwen = options(request).qwen
  return {
    model: request.model.id,
    input: messageInput(request),
    parameters: {
      size: request.size === undefined ? undefined : `${request.size.width}*${request.size.height}`,
      n: request.count,
      negative_prompt: qwen?.negativePrompt,
      prompt_extend: qwen?.promptExtend,
      watermark: qwen?.watermark,
      seed: request.seed,
    },
  }
}

const wanBody = (request: ImageRequest): WanBody => {
  const wan = options(request).wan
  return {
    model: request.model.id,
    input: messageInput(request),
    parameters: {
      size:
        wan?.resolution ?? (request.size === undefined ? undefined : `${request.size.width}*${request.size.height}`),
      n: request.count,
      thinking_mode: wan?.thinkingMode,
      color_palette: wan?.colorPalette === undefined ? undefined : [...wan.colorPalette],
      watermark: wan?.watermark,
      seed: request.seed,
    },
  }
}

const invalidOutput = (message: string, metadata?: Record<string, unknown>) =>
  new LLMError({
    module: ADAPTER,
    method: "generate",
    reason: new InvalidProviderOutputReason({
      message,
      route: ADAPTER,
      providerMetadata: metadata === undefined ? undefined : { alibaba: metadata },
    }),
  })

const providerError = (code: string | undefined, message: string | undefined, requestID: string | undefined) =>
  new LLMError({
    module: ADAPTER,
    method: "generate",
    reason: new UnknownProviderReason({
      message: [code, message].filter(Boolean).join(": ") || "Alibaba image generation failed",
      providerMetadata: { alibaba: { code, requestId: requestID } },
    }),
  })

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const PROTOCOL_BODY_FIELDS = new Set(["model", "input", "parameters"])

const bodyWithOverlay = Effect.fn("AlibabaImages.bodyWithOverlay")(function* (
  imageBody: QwenBody | WanBody,
  overlay: Record<string, unknown> | undefined,
) {
  if (!overlay) return imageBody
  const reserved = Object.keys(overlay).filter((key) => PROTOCOL_BODY_FIELDS.has(key))
  if (reserved.length > 0)
    return yield* ProviderShared.invalidRequest(
      `http.body cannot overlay protocol-owned field(s): ${reserved.join(", ")}`,
    )
  return mergeJsonRecords(imageBody, overlay) ?? imageBody
})

const expiration = (url: string) => {
  if (!URL.canParse(url)) return undefined
  const value = new URL(url).searchParams.get("Expires")
  if (value === null || !Number.isFinite(Number(value))) return undefined
  return new Date(Number(value) * 1000).toISOString()
}

export const model = (input: ModelInput) => {
  const route: ImageRoute = {
    id: `${ADAPTER}-${input.family}`,
    generate: Effect.fn("AlibabaImages.generate")(function* (request: ImageRequest, execute) {
      if (request.aspectRatio !== undefined)
        return yield* ProviderShared.invalidRequest("Alibaba Images does not support the common aspectRatio option")
      if (
        input.family === "qwen" &&
        (request.model.defaults?.providerOptions?.alibaba?.wan !== undefined ||
          request.providerOptions?.alibaba?.wan !== undefined)
      )
        return yield* ProviderShared.invalidRequest("Qwen Image does not accept providerOptions.alibaba.wan")
      if (
        input.family === "wan" &&
        (request.model.defaults?.providerOptions?.alibaba?.qwen !== undefined ||
          request.providerOptions?.alibaba?.qwen !== undefined)
      )
        return yield* ProviderShared.invalidRequest("Wan Image does not accept providerOptions.alibaba.qwen")
      if (input.family === "wan" && request.size !== undefined && options(request).wan?.resolution !== undefined)
        return yield* ProviderShared.invalidRequest("Wan Image accepts either size or resolution, not both")

      const requestBody = yield* ProviderShared.validateWith(
        Schema.decodeUnknownEffect(input.family === "qwen" ? QwenBody : WanBody),
      )(input.family === "qwen" ? qwenBody(request) : wanBody(request))
      const http = mergeHttpOptions(request.model.defaults?.http, request.http)
      const overlaidBody = yield* bodyWithOverlay(requestBody, http?.body)
      const text = ProviderShared.encodeJson(overlaidBody)
      const url = applyQuery(`${(input.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${PATH}`, http?.query)
      const headers = yield* Auth.toEffect(input.auth)({
        request,
        method: "POST",
        url,
        body: text,
        headers: Headers.fromInput({ ...input.headers, ...http?.headers }),
      })
      const response = yield* execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyText(text, "application/json"),
        ),
      )
      const payload = yield* response.json.pipe(
        Effect.mapError(() => invalidOutput("Failed to read the Alibaba Images response")),
      )
      const decoded = yield* Schema.decodeUnknownEffect(AlibabaResponse)(payload).pipe(
        Effect.mapError(() => invalidOutput("Alibaba Images returned an invalid response")),
      )
      if (decoded.code !== undefined || decoded.output === undefined)
        return yield* providerError(decoded.code, decoded.message, decoded.request_id)
      const urls = decoded.output.choices.flatMap((choice) => choice.message.content.map((content) => content.image))
      if (urls.length === 0)
        return yield* invalidOutput("Alibaba Images returned no images", { requestId: decoded.request_id })

      return new ImageResponse({
        images: urls.map(
          (url) =>
            new GeneratedImage({
              mediaType: "image/png",
              data: url,
              providerMetadata: {
                alibaba: {
                  modelId: request.model.id,
                  family: input.family,
                  expiresAt: expiration(url),
                },
              },
            }),
        ),
        usage:
          decoded.usage === undefined
            ? undefined
            : new Usage({
                inputTokens: decoded.usage.input_tokens,
                outputTokens: decoded.usage.output_tokens,
                totalTokens: decoded.usage.total_tokens,
                providerMetadata: { alibaba: decoded.usage },
              }),
        providerMetadata: {
          alibaba: {
            requestId: decoded.request_id,
            modelId: request.model.id,
            family: input.family,
          },
        },
      })
    }),
  }
  return ImageModel.make({ id: input.id, provider: "alibaba", route, defaults: input.defaults })
}

export const AlibabaImages = {
  model,
} as const
