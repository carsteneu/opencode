import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { TransportTimeout } from "../src/route/transport"
import type { Interface } from "../src/route/transport/websocket"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { ProviderShared } from "../src/protocols/shared"
import { it } from "./lib/effect"
import { fixedResponse } from "./lib/http"

const request = HttpClientRequest.post("https://provider.test/v1/chat")

const timeout = (error: unknown, phase: "headers" | "chunk", timeoutMs: number) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  expect(error.reason).toMatchObject({ _tag: "Timeout", phase, timeoutMs })
  expect(error.retryable).toBe(true)
}

const pendingBody = () => {
  const encoder = new TextEncoder()
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let pulls = 0
  let cancels = 0
  const notify = () => {
    waiters.splice(0).forEach((waiter) => {
      if (pulls >= waiter.count) waiter.resolve()
      else waiters.push(waiter)
    })
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        pulls += 1
        notify()
      },
      cancel() {
        cancels += 1
      },
    },
    { highWaterMark: 0 },
  )
  return {
    body,
    enqueue: (value: string) => controller?.enqueue(encoder.encode(value)),
    waitForPull: (count: number) =>
      pulls >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve })
          }),
    pulls: () => pulls,
    cancels: () => cancels,
  }
}

const chunkedBody = (value: string, chunkSize: number) => {
  const bytes = new TextEncoder().encode(value)
  let offset = 0
  let pulls = 0
  let cancels = 0
  return {
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          if (offset === bytes.byteLength) {
            controller.close()
            return
          }
          const next = bytes.slice(offset, offset + chunkSize)
          offset += next.byteLength
          controller.enqueue(next)
        },
        cancel() {
          cancels += 1
        },
      },
      { highWaterMark: 0 },
    ),
    pulls: () => pulls,
    cancels: () => cancels,
  }
}

const httpLayer = (
  execute: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) => RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))))

const webSocketRuntime = (webSocket: Interface) =>
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(WebSocketExecutor.Service, WebSocketExecutor.Service.of(webSocket)),
      ),
    ),
  )

describe("transport timeouts", () => {
  it.effect("times out response headers at the exact boundary without retrying and cancels the request", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const canceled = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const layer = httpLayer(() =>
        Ref.update(attempts, (value) => value + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(canceled, (value) => value + 1)),
        ),
      )
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(request, { headerTimeout: 1_000 })
      }).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust(999)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      timeout(yield* Fiber.join(fiber), "headers", 1_000)
      expect(yield* Ref.get(attempts)).toBe(1)
      expect(yield* Ref.get(canceled)).toBe(1)
    }),
  )

  it.effect("disables the header timeout with false and preserves caller cancellation", () =>
    Effect.gen(function* () {
      const canceled = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const layer = httpLayer(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(canceled, (value) => value + 1)),
        ),
      )
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(request, { headerTimeout: false })
      }).pipe(Effect.provide(layer), Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust("1 day")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* Ref.get(canceled)).toBe(1)
    }),
  )

  it.effect("bounds and redacts oversized non-success bodies and cancels each producer", () =>
    Effect.gen(function* () {
      const secret = `secret-across-boundary-${"z".repeat(128)}`
      const bodies = Array.from({ length: 3 }, () => chunkedBody(`${"x".repeat(16_380)}${secret}`, 4_096))
      const attempts = yield* Ref.make(0)
      const cursor = yield* Ref.make(0)
      const layer = httpLayer((request) =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (value) => value + 1)
          const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
          return HttpClientResponse.fromWeb(
            request,
            new Response(bodies[index]?.body ?? bodies.at(-1)!.body, {
              status: 503,
              headers: { "retry-after-ms": "0" },
            }),
          )
        }),
      )
      const secured = HttpClientRequest.setHeader(request, "authorization", `Bearer ${secret}`)
      const error = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(secured)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError) || !("http" in error.reason)) throw new Error("expected HTTP LLMError")
      expect(error.reason.http?.body).toBe("[Provider response body exceeded 16384 bytes]")
      expect(error.reason.http?.bodyTruncated).toBe(true)
      expect(error.reason.http?.body).not.toContain(secret.slice(0, 24))
      expect(yield* Ref.get(attempts)).toBe(3)
      expect(bodies.map((body) => body.cancels())).toEqual([1, 1, 1])
      expect(bodies.every((body) => body.pulls() <= 5)).toBe(true)
    }),
  )

  it.effect("times out a stalled non-success body once and cancels its reader", () =>
    Effect.gen(function* () {
      const source = pendingBody()
      const attempts = yield* Ref.make(0)
      const layer = httpLayer((request) =>
        Ref.update(attempts, (value) => value + 1).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(source.body, { status: 503 }))),
        ),
      )
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(request, { chunkTimeout: 1_000 })
      }).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild)

      yield* Effect.promise(() => source.waitForPull(1))
      yield* TestClock.adjust(999)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      timeout(yield* Fiber.join(fiber), "chunk", 1_000)
      expect(yield* Ref.get(attempts)).toBe(1)
      expect(source.cancels()).toBe(1)
    }),
  )

  it.effect("resets native HTTP idle time on raw SSE comments and partial frames before framing", () =>
    Effect.gen(function* () {
      const source = pendingBody()
      const model = OpenAIChat.route
        .with({
          endpoint: { baseURL: "https://provider.test/v1" },
          auth: Auth.none,
          http: { headerTimeout: false, chunkTimeout: 1_000 },
        })
        .model({ id: "test-model" })
      const fiber = LLMClient.stream(LLM.request({ model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(fixedResponse(source.body, { status: 200, headers: { "Content-Type": "Text/Event-Stream" } })),
        Effect.flip,
        Effect.forkChild,
      )
      const running = yield* fiber

      yield* Effect.promise(() => source.waitForPull(1))
      yield* TestClock.adjust(999)
      source.enqueue(": keepalive\n\n")
      yield* Effect.promise(() => source.waitForPull(2))
      yield* TestClock.adjust(999)
      source.enqueue("data: {")
      yield* Effect.promise(() => source.waitForPull(3))
      yield* TestClock.adjust(999)
      expect(running.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      timeout(yield* Fiber.join(running), "chunk", 1_000)
      expect(source.cancels()).toBe(1)
    }),
  )

  it.effect("does not count downstream backpressure as provider idle time", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const nextPull = yield* Deferred.make<void>()
      const finalized = yield* Ref.make(0)
      const source = Stream.make(new Uint8Array([1])).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(nextPull, undefined).pipe(Effect.andThen(Effect.never)))),
        Stream.ensuring(Ref.update(finalized, (value) => value + 1)),
      )
      const fiber = TransportTimeout.stream(source, {
        module: "test",
        phase: "chunk",
        timeout: 1_000,
      }).pipe(
        Stream.runForEach(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.flip,
        Effect.forkChild,
      )
      const running = yield* fiber

      yield* Deferred.await(entered)
      yield* TestClock.adjust(5_000)
      expect(running.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(nextPull)
      yield* TestClock.adjust(1_000)
      timeout(yield* Fiber.join(running), "chunk", 1_000)
      expect(yield* Ref.get(finalized)).toBe(1)
    }),
  )

  it.effect("times out WebSocket opening at the exact boundary and cancels the open operation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const canceled = yield* Ref.make(0)
      const model = OpenAIResponses.webSocketRoute
        .with({
          endpoint: { baseURL: "https://provider.test/v1" },
          auth: Auth.none,
          http: { headerTimeout: 1_000, chunkTimeout: false },
        })
        .model({ id: "test-model" })
      const runtime = webSocketRuntime({
        open: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.update(canceled, (value) => value + 1)),
          ),
      })
      const fiber = LLMClient.stream(LLM.request({ model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(runtime),
        Effect.flip,
        Effect.forkChild,
      )
      const running = yield* fiber

      yield* Deferred.await(started)
      yield* TestClock.adjust(999)
      expect(running.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      timeout(yield* Fiber.join(running), "headers", 1_000)
      expect(yield* Ref.get(canceled)).toBe(1)
    }),
  )

  it.effect("resets WebSocket idle time per message and closes the scoped connection on timeout", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.unbounded<string>()
      const seen = yield* Queue.unbounded<void>()
      const closed = yield* Ref.make(0)
      const model = OpenAIResponses.webSocketRoute
        .with({
          endpoint: { baseURL: "https://provider.test/v1" },
          auth: Auth.none,
          http: { headerTimeout: false, chunkTimeout: 1_000 },
        })
        .model({ id: "test-model" })
      const runtime = webSocketRuntime({
        open: () =>
          Effect.succeed({
            sendText: () => Effect.void,
            messages: Stream.fromQueue(messages),
            close: Ref.update(closed, (value) => value + 1),
          }),
      })
      const fiber = LLMClient.stream(LLM.request({ model, prompt: "hello" })).pipe(
        Stream.tap((event) => (event.type === "text-delta" ? Queue.offer(seen, undefined) : Effect.void)),
        Stream.runDrain,
        Effect.provide(runtime),
        Effect.flip,
        Effect.forkChild,
      )
      const running = yield* fiber

      yield* TestClock.adjust(999)
      yield* Queue.offer(
        messages,
        ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "A" }),
      )
      yield* Queue.take(seen)
      yield* TestClock.adjust(999)
      yield* Queue.offer(
        messages,
        ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "B" }),
      )
      yield* Queue.take(seen)
      yield* TestClock.adjust(999)
      expect(running.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      timeout(yield* Fiber.join(running), "chunk", 1_000)
      expect(yield* Ref.get(closed)).toBe(1)
    }),
  )

  it.effect("disables WebSocket message timeout with false and closes only on caller cancellation", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>()
      const closed = yield* Ref.make(0)
      const model = OpenAIResponses.webSocketRoute
        .with({
          endpoint: { baseURL: "https://provider.test/v1" },
          auth: Auth.none,
          http: { headerTimeout: false, chunkTimeout: false },
        })
        .model({ id: "test-model" })
      const runtime = webSocketRuntime({
        open: () =>
          Deferred.succeed(opened, undefined).pipe(
            Effect.as({
              sendText: () => Effect.void,
              messages: Stream.never,
              close: Ref.update(closed, (value) => value + 1),
            }),
          ),
      })
      const running = yield* LLMClient.stream(LLM.request({ model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(runtime),
        Effect.forkChild,
      )

      yield* Deferred.await(opened)
      yield* TestClock.adjust("1 day")
      expect(running.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(running)
      expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true)
      expect(yield* Ref.get(closed)).toBe(1)
    }),
  )
})
