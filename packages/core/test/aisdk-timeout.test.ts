import { describe, expect } from "bun:test"
import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.locationLayer)

function model(settings: Record<string, unknown>, modelID = "timeout-model") {
  const id = ModelV2.ID.make(modelID)
  return ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("timeout-provider"), id),
    api: { id, type: "aisdk", package: "fixture-provider", settings },
  })
}

const optionsFor = Effect.fn(function* (settings: Record<string, unknown>, modelID?: string) {
  const aisdk = yield* AISDK.Service
  const events: AISDK.SDKEvent[] = []
  yield* aisdk.hook.sdk((event) => {
    events.push(event)
    event.sdk = { languageModel: () => ({}) }
  })
  yield* aisdk.language(model(settings, modelID))
  return events[0]!.options
})

describe("AISDK transport timeouts", () => {
  it.live("aborts a fetch that stalls before response headers and strips transport settings", () =>
    Effect.gen(function* () {
      const options = yield* optionsFor({
        headerTimeout: 20,
        chunkTimeout: false,
        fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) return reject(new Error("missing timeout signal"))
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          }),
      })

      const error = yield* Effect.promise(() =>
        options.fetch("https://provider.example").then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      )

      expect(options.headerTimeout).toBeUndefined()
      expect(options.chunkTimeout).toBeUndefined()
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Provider response headers timed out after 20ms")
    }),
  )

  it.live("clears the header timer when a custom fetch throws synchronously", () =>
    Effect.gen(function* () {
      const original = new Error("synchronous fetch failure")
      const signals: AbortSignal[] = []
      const options = yield* optionsFor({
        headerTimeout: 20,
        chunkTimeout: false,
        fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (init?.signal) signals.push(init.signal)
          throw original
        },
      })

      const error = yield* Effect.promise(() =>
        options.fetch("https://provider.example").then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      )
      yield* Effect.promise(() => Bun.sleep(40))

      expect(error).toBe(original)
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)
    }),
  )

  it.live("starts case-insensitive SSE timeouts on demand and keeps them when cancellation rejects", () =>
    Effect.gen(function* () {
      const cancellations: unknown[] = []
      const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
      const options = yield* optionsFor({
        headerTimeout: false,
        chunkTimeout: 20,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controllers.push(controller)
                },
                cancel(reason) {
                  cancellations.push(reason)
                  return Promise.reject(new Error("producer cancellation failed"))
                },
              }),
              { headers: { "content-type": "Text/Event-Stream; Charset=UTF-8" } },
            ),
          ),
      })
      const response = yield* Effect.promise(() => (options.fetch as typeof fetch)("https://provider.example"))
      yield* Effect.promise(() => Bun.sleep(40))
      controllers[0].enqueue(new TextEncoder().encode(": keepalive\n\n"))
      const reader = response.body!.getReader()
      const first = yield* Effect.promise(() => reader.read())
      const error = yield* Effect.promise(() => reader.read().then(undefined, (cause: unknown) => cause))

      expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("SSE read timed out")
      expect(cancellations).toEqual([error])
    }),
  )

  it.live("disables both timeouts with false and enables timeout signals by default", () =>
    Effect.gen(function* () {
      const disabledSignals: Array<AbortSignal | null | undefined> = []
      const disabled = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: false,
          fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            disabledSignals.push(init?.signal)
            return Promise.resolve(new Response("ok"))
          },
        },
        "disabled-timeout-model",
      )
      yield* Effect.promise(() => disabled.fetch("https://provider.example"))

      expect(disabledSignals).toEqual([undefined])

      const defaultSignals: Array<AbortSignal | null | undefined> = []
      const defaults = yield* optionsFor(
        {
          fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            defaultSignals.push(init?.signal)
            return Promise.resolve(new Response("ok"))
          },
        },
        "default-timeout-model",
      )
      yield* Effect.promise(() => defaults.fetch("https://provider.example"))

      expect(defaultSignals[0]).toBeInstanceOf(AbortSignal)
      expect(defaultSignals[0]?.aborted).toBe(false)
    }),
  )
})
