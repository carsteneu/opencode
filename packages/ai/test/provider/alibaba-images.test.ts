import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { Image, ImageClient } from "../../src"
import { Alibaba } from "../../src/providers"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"

const response = (family: "qwen" | "wan") => ({
  output: {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: [
            {
              image: "https://dashscope-result-intl.oss-cn-singapore.aliyuncs.com/result.png?Expires=1893456000",
              ...(family === "wan" ? { type: "image" } : {}),
            },
          ],
        },
      },
    ],
    ...(family === "wan" ? { finished: true } : {}),
  },
  usage:
    family === "wan"
      ? { image_count: 1, input_tokens: 10, output_tokens: 2, total_tokens: 12, size: "2048*2048" }
      : { image_count: 1, width: 1024, height: 768 },
  request_id: `request-${family}`,
})

describe("Alibaba Images", () => {
  it.effect("generates Qwen Image 2.0 through the international synchronous route", () =>
    Effect.gen(function* () {
      const result = yield* Image.generate({
        model: Alibaba.configure({
          apiKey: "test",
          baseURL: "https://dashscope-intl.test/api/v1",
          image: { providerOptions: { qwen: { promptExtend: true, watermark: false } } },
          http: { headers: { "x-default": "yes" } },
        }).image("qwen-image-2.0-pro"),
        prompt: "A robot tending a rooftop garden",
        count: 2,
        size: { width: 1024, height: 768 },
        seed: 42,
        providerOptions: { alibaba: { qwen: { negativePrompt: "blurry" } } },
        http: { headers: { "x-request": "yes" }, query: { trace: "1" }, body: { metadata: "test" } },
      })

      expect(result.image?.data).toContain("dashscope-result-intl")
      expect(result.image?.expiresAt).toBe("2030-01-01T00:00:00.000Z")
      expect(result.image?.providerMetadata).toEqual({
        alibaba: {
          modelId: "qwen-image-2.0-pro",
          family: "qwen",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      })
      expect(result.providerMetadata).toEqual({
        alibaba: { requestId: "request-qwen", modelId: "qwen-image-2.0-pro", family: "qwen" },
      })
    }).pipe(
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe(
                  "https://dashscope-intl.test/api/v1/services/aigc/multimodal-generation/generation?trace=1",
                )
                expect(request.headers.get("authorization")).toBe("Bearer test")
                expect(request.headers.get("x-default")).toBe("yes")
                expect(request.headers.get("x-request")).toBe("yes")
                expect(JSON.parse(input.text)).toEqual({
                  model: "qwen-image-2.0-pro",
                  input: {
                    messages: [{ role: "user", content: [{ text: "A robot tending a rooftop garden" }] }],
                  },
                  parameters: {
                    size: "1024*768",
                    n: 2,
                    negative_prompt: "blurry",
                    prompt_extend: true,
                    watermark: false,
                    seed: 42,
                  },
                  metadata: "test",
                })
                return input.respond(JSON.stringify(response("qwen")), {
                  headers: { "content-type": "application/json" },
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("generates Wan 2.7 through the international synchronous route", () =>
    Effect.gen(function* () {
      const result = yield* Image.generate({
        model: Alibaba.configure({ apiKey: "test", baseURL: "https://dashscope-intl.test/api/v1" }).image(
          "wan2.7-image-pro",
        ),
        prompt: "A flower shop with a wooden door",
        count: 1,
        seed: 7,
        providerOptions: {
          alibaba: {
            wan: {
              resolution: "2K",
              thinkingMode: true,
              watermark: false,
              colorPalette: [
                { hex: "#112233", ratio: "60.00%" },
                { hex: "#445566", ratio: "25.00%" },
                { hex: "#778899", ratio: "15.00%" },
              ],
            },
          },
        },
      })

      expect(result.images).toHaveLength(1)
      expect(result.image?.mediaType).toBe("image/png")
      expect(result.usage?.totalTokens).toBe(12)
      expect(result.usage?.providerMetadata).toEqual({ alibaba: response("wan").usage })
    }).pipe(
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe(
                  "https://dashscope-intl.test/api/v1/services/aigc/multimodal-generation/generation",
                )
                expect(JSON.parse(input.text)).toEqual({
                  model: "wan2.7-image-pro",
                  input: { messages: [{ role: "user", content: [{ text: "A flower shop with a wooden door" }] }] },
                  parameters: {
                    size: "2K",
                    n: 1,
                    thinking_mode: true,
                    color_palette: [
                      { hex: "#112233", ratio: "60.00%" },
                      { hex: "#445566", ratio: "25.00%" },
                      { hex: "#778899", ratio: "15.00%" },
                    ],
                    watermark: false,
                    seed: 7,
                  },
                })
                return input.respond(JSON.stringify(response("wan")), {
                  headers: { "content-type": "application/json" },
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("surfaces Alibaba error envelopes as typed provider errors", () =>
    Image.generate({
      model: Alibaba.configure({ apiKey: "test" }).image("qwen-image-2.0"),
      prompt: "A robot",
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("UnknownProvider")
          expect(error.message).toContain("InvalidParameter: invalid prompt")
        }),
      ),
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.succeed(
                input.respond(
                  JSON.stringify({ request_id: "request-error", code: "InvalidParameter", message: "invalid prompt" }),
                  { headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects parameters overlays owned by the protocol", () =>
    Image.generate({
      model: Alibaba.configure({ apiKey: "test" }).image("qwen-image-2.0"),
      prompt: "A robot",
      http: { body: { parameters: { watermark: true } } },
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("InvalidRequest")
          expect(error.message).toContain("http.body cannot overlay protocol-owned field(s): parameters")
        }),
      ),
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse(() => Effect.die("reserved body validation must happen before the request is sent")),
          ),
        ),
      ),
    ),
  )

  it.effect("ignores finite expiration values outside the Date range", () =>
    Effect.gen(function* () {
      const result = yield* Image.generate({
        model: Alibaba.configure({ apiKey: "test" }).image("qwen-image-2.0"),
        prompt: "A robot",
      })

      expect(result.image?.expiresAt).toBeUndefined()
      expect(result.image?.providerMetadata?.alibaba?.expiresAt).toBeUndefined()
    }).pipe(
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              const payload = response("qwen")
              payload.output.choices[0].message.content[0].image =
                "https://dashscope-result-intl.oss-cn-singapore.aliyuncs.com/result.png?Expires=9007199254740991"
              return Effect.succeed(
                input.respond(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
              )
            }),
          ),
        ),
      ),
    ),
  )
})
