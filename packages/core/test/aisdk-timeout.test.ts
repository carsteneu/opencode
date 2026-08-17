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

const bodyTypes = [
  ["json", "application/json"],
  ["ndjson", "application/x-ndjson"],
  ["bedrock", "application/vnd.amazon.eventstream"],
  ["binary", "application/octet-stream"],
  ["missing", undefined],
] as const

function pendingResponse(contentType?: string) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let pulls = 0
  const cancellations: unknown[] = []
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
        },
        pull() {
          pulls += 1
        },
        cancel(reason) {
          cancellations.push(reason)
        },
      },
      { highWaterMark: 0 },
    ),
    contentType ? { headers: { "content-type": contentType } } : undefined,
  )
  return {
    response,
    enqueue: (value: string) => controller?.enqueue(new TextEncoder().encode(value)),
    close: () => controller?.close(),
    pulls: () => pulls,
    cancellations: () => cancellations,
  }
}

function withMetadata(response: Response, name: string) {
  Object.defineProperties(response, {
    url: { configurable: true, value: `https://provider.example/final/${name}` },
    redirected: { configurable: true, value: true },
    type: { configurable: true, value: "cors" },
  })
  return response
}

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

  it.live("times out JSON, NDJSON, Bedrock, binary, and untyped bodies after resetting on bytes", () =>
    Effect.gen(function* () {
      const sources = new Map<string, ReturnType<typeof pendingResponse>>(
        bodyTypes.map(([name, contentType]) => [name, pendingResponse(contentType)]),
      )
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 100,
          fetch: (input: Parameters<typeof fetch>[0]) => {
            const source = sources.get(new URL(String(input)).searchParams.get("case") ?? "")
            if (!source) throw new Error("unknown response body case")
            return Promise.resolve(source.response)
          },
        },
        "body-type-timeout-model",
      )
      const runtimeFetch = options.fetch as typeof fetch

      yield* Effect.promise(() =>
        Promise.all(
          bodyTypes.map(async ([name]) => {
            const source = sources.get(name)!
            const response = await runtimeFetch(`https://provider.example?case=${name}`)
            const reader = response.body!.getReader()

            source.enqueue("first")
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")
            const second = reader.read()
            await Bun.sleep(10)
            source.enqueue("second")
            expect(new TextDecoder().decode((await second).value)).toBe("second")
            const error = await reader.read().then(undefined, (cause: unknown) => cause)

            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe("Provider response stream timed out")
            expect(source.cancellations()).toEqual([error])
          }),
        ),
      )
    }),
  )

  it.live("does not start a body timeout until an unread response is pulled", () =>
    Effect.gen(function* () {
      const source = pendingResponse("application/json")
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 20,
          fetch: () => Promise.resolve(source.response),
        },
        "unread-body-timeout-model",
      )
      const response = yield* Effect.promise(() => (options.fetch as typeof fetch)("https://provider.example"))

      yield* Effect.promise(() => Bun.sleep(40))
      expect(source.pulls()).toBe(0)
      expect(source.cancellations()).toEqual([])

      source.enqueue("available")
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe("available")
      const error = yield* Effect.promise(() => reader.read().then(undefined, (cause: unknown) => cause))
      expect((error as Error).message).toBe("Provider response stream timed out")
      expect(source.cancellations()).toEqual([error])
    }),
  )

  it.live("keeps both clone branches alive when neither body is read before the timeout", () =>
    Effect.gen(function* () {
      const source = pendingResponse("application/json")
      let signal: AbortSignal | null | undefined
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 20,
          fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            signal = init?.signal
            return Promise.resolve(source.response)
          },
        },
        "unread-clone-timeout-model",
      )
      const response = yield* Effect.promise(() => (options.fetch as typeof fetch)("https://provider.example"))
      const clone = response.clone()

      yield* Effect.promise(() => Bun.sleep(40))
      expect(signal?.aborted).toBe(false)
      expect(source.cancellations()).toEqual([])

      source.enqueue("complete")
      source.close()
      expect(yield* Effect.promise(() => Promise.all([response.text(), clone.text()]))).toEqual([
        "complete",
        "complete",
      ])
    }),
  )

  it.live("preserves complete JSON and binary bytes plus response metadata through clone", () =>
    Effect.gen(function* () {
      const bodies = [
        ["json", new TextEncoder().encode('{"ok":true}')],
        ["binary", new Uint8Array([0, 255, 128, 10])],
      ] as const
      const responses = new Map<string, Response>(
        bodies.map(([name, bytes]) => [
          name,
          withMetadata(
            new Response(bytes, {
              status: 206,
              statusText: "Partial Content",
              headers: {
                "content-type": name === "json" ? "application/json" : "application/octet-stream",
                "x-test": name,
              },
            }),
            name,
          ),
        ]),
      )
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 1_000,
          fetch: (input: Parameters<typeof fetch>[0]) =>
            Promise.resolve(responses.get(new URL(String(input)).searchParams.get("case") ?? "")!),
        },
        "body-metadata-model",
      )
      const runtimeFetch = options.fetch as typeof fetch

      yield* Effect.promise(() =>
        Promise.all(
          bodies.map(async ([name, bytes]) => {
            const source = responses.get(name)!
            const response = await runtimeFetch(`https://provider.example?case=${name}`)
            response.headers.set("x-before-clone", "inherited")
            const clone = response.clone()

            expect(response).not.toBe(source)
            ;[response, clone].forEach((current) => {
              expect(current.url).toBe(`https://provider.example/final/${name}`)
              expect(current.redirected).toBe(true)
              expect(current.type).toBe("cors")
              expect(current.status).toBe(206)
              expect(current.statusText).toBe("Partial Content")
              expect(current.headers.get("x-test")).toBe(name)
              expect(current.headers.get("x-before-clone")).toBe("inherited")
            })
            response.headers.set("x-parent-after-clone", "parent")
            clone.headers.set("x-child-after-clone", "child")
            expect(clone.headers.get("x-parent-after-clone")).toBeNull()
            expect(response.headers.get("x-child-after-clone")).toBeNull()
            const output = await Promise.all([response.arrayBuffer(), clone.arrayBuffer()])
            output.forEach((value) => expect(new Uint8Array(value)).toEqual(bytes))
          }),
        ),
      )
    }),
  )

  it.live("keeps a cloned response alive until every branch is canceled", () =>
    Effect.gen(function* () {
      const source = pendingResponse("application/octet-stream")
      let signal: AbortSignal | null | undefined
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 1_000,
          fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            signal = init?.signal
            return Promise.resolve(source.response)
          },
        },
        "body-clone-cancel-model",
      )
      const response = yield* Effect.promise(() => (options.fetch as typeof fetch)("https://provider.example"))
      const clone = response.clone()
      const first = response.body!.getReader()
      const second = clone.body!.getReader()

      const firstCancel = first.cancel("first")
      expect(signal?.aborted).toBe(false)
      expect(source.cancellations()).toEqual([])
      source.enqueue("still available")
      expect(new TextDecoder().decode((yield* Effect.promise(() => second.read())).value)).toBe("still available")
      const secondCancel = second.cancel("second")
      yield* Effect.promise(() => Promise.all([firstCancel, secondCancel]))

      expect(signal?.aborted).toBe(true)
      expect(signal?.reason).toBe("second")
      expect(source.cancellations()).toEqual([["first", "second"]])
    }),
  )

  it.live("shares a body timeout across active and not-yet-read clone branches", () =>
    Effect.gen(function* () {
      const source = pendingResponse("application/json")
      const options = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 20,
          fetch: () => Promise.resolve(source.response),
        },
        "body-clone-timeout-model",
      )
      const response = yield* Effect.promise(() => (options.fetch as typeof fetch)("https://provider.example"))
      const activeClone = response.clone()
      const lateClone = response.clone()
      const originalRead = response
        .body!.getReader()
        .read()
        .then(undefined, (cause: unknown) => cause)
      const cloneRead = activeClone
        .body!.getReader()
        .read()
        .then(undefined, (cause: unknown) => cause)
      const [originalError, cloneError] = yield* Effect.promise(() => Promise.all([originalRead, cloneRead]))

      expect(originalError).toBeInstanceOf(Error)
      expect((originalError as Error).message).toBe("Provider response stream timed out")
      expect(cloneError).toBe(originalError)
      const lateError = yield* Effect.promise(() =>
        lateClone
          .body!.getReader()
          .read()
          .then(undefined, (cause: unknown) => cause),
      )
      expect(lateError).toBe(originalError)
      expect(source.cancellations()).toHaveLength(1)
    }),
  )

  it.live("returns the original response when body wrapping is disabled or impossible", () =>
    Effect.gen(function* () {
      const disabledResponse = new Response("disabled")
      const disabled = yield* optionsFor(
        { headerTimeout: false, chunkTimeout: false, fetch: () => Promise.resolve(disabledResponse) },
        "disabled-body-timeout-model",
      )
      expect(yield* Effect.promise(() => disabled.fetch("https://provider.example"))).toBe(disabledResponse)

      const nullResponse = new Response(null)
      const usedResponse = new Response("used")
      yield* Effect.promise(() => usedResponse.text())
      const lockedResponse = new Response("locked")
      const lock = lockedResponse.body!.getReader()
      const responses = new Map([
        ["null", nullResponse],
        ["used", usedResponse],
        ["locked", lockedResponse],
      ])
      const enabled = yield* optionsFor(
        {
          headerTimeout: false,
          chunkTimeout: 20,
          fetch: (input: Parameters<typeof fetch>[0]) =>
            Promise.resolve(responses.get(new URL(String(input)).searchParams.get("case") ?? "")!),
        },
        "passthrough-body-timeout-model",
      )
      yield* Effect.promise(() =>
        Promise.all(
          Array.from(responses, async ([name, response]) => {
            expect(await enabled.fetch(`https://provider.example?case=${name}`)).toBe(response)
          }),
        ),
      )
      yield* Effect.promise(() => lock.cancel())
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
