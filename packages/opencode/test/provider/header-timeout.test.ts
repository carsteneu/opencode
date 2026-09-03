import { afterEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { applyRuntimeFetch } from "@/provider/runtime-fetch"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

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

it.live(
  "headerTimeout does not abort delayed SSE body after headers arrive",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => delayedBodyServer(1_000)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              messages: [{ role: "user", content: "hello" }],
            })

            expect(yield* Effect.promise(() => result.text)).toBe("late")
          }),
        { config: providerConfig(server.url, { headerTimeout: 500 }) },
      )
    }),
  15_000,
)

for (const timeout of ["chunkTimeout", "headerTimeout"] as const) {
  it.live(`default ${timeout} is applied at fetch`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => delayedBodyServer(250)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            const signals: (AbortSignal | null | undefined)[] = []
            configured.options.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
              signals.push(init?.signal)
              return fetch(input, init)
            }
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const language = yield* provider.getLanguage(model)
            yield* Effect.acquireRelease(
              Effect.promise(() =>
                language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
              ),
              (result) => Effect.promise(() => result.stream.cancel()),
            )

            expect(signals).toHaveLength(1)
            expect(signals[0]).toBeInstanceOf(AbortSignal)
            expect(configured.options[timeout]).toBe(300_000) // fork: llm schema bakes defaults into options
          }),
        {
          config: providerConfig(server.url, {
            [timeout === "chunkTimeout" ? "headerTimeout" : "chunkTimeout"]: false,
          }),
        },
      )
    }),
  )
}

it.live("configured chunkTimeout raises a retryable response stream error when SSE body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (error) {
              return error
            }
          })
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          expect(
            SessionRetry.retryable(MessageV2.fromError(error, { providerID: model.providerID }), model.providerID),
          ).toEqual({ message: "SSE read timed out" })
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50 }) },
    )
  }),
)

it.live("chunkTimeout raises a response stream error when an OpenAI 500 JSON body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => stalledErrorBodyServer()),
      (server) =>
        Effect.sync(() => {
          server.server.closeAllConnections()
          server.server.close()
        }),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            maxRetries: 0,
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (cause) {
              return cause
            }
          })
          const timeout = ProviderError.findTimeout(error)
          expect(timeout).toBeInstanceOf(ProviderError.ResponseStreamError)
          expect(timeout?.message).toBe("Provider response stream timed out")
          expect(server.requests()).toBe(1)
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50 }) },
    )
  }),
)

it.live("headerTimeout aborts when response headers do not arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { headerTimeout: 50 }) },
    )
  }),
)

it.live("provider transport timeouts default to five minutes", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(100)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const info = yield* provider.getProvider(ProviderV2.ID.make("test"))
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(info.options.headerTimeout).toBe(300_000)
          expect(info.options.chunkTimeout).toBe(300_000)
          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url) },
    )
  }),
)

it.live("OpenAI Codex transport timeout defaults can be disabled by config", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(false)
              expect(openai.options.chunkTimeout).toBe(false)
            }),
          { config: { provider: { openai: { options: { headerTimeout: false, chunkTimeout: false } } } } },
        )
      }),
    )
  }),
)

it.live("OpenAI API auth gets default transport timeouts", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const openai = yield* provider.getProvider(ProviderV2.ID.openai)
            expect(openai.options.headerTimeout).toBe(300_000)
            expect(openai.options.chunkTimeout).toBe(300_000)
          }),
        )
      }),
      { openai: { type: "api", key: "sk-test" } },
    )
  }),
)

it.live("runtime fetch clears the header timer when a custom fetch throws synchronously", () =>
  Effect.gen(function* () {
    const original = new Error("synchronous fetch failure")
    const signals: AbortSignal[] = []
    const options = applyRuntimeFetch({
      headerTimeout: 20,
      chunkTimeout: false,
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal)
        throw original
      },
    })
    const runtimeFetch = options.fetch as typeof fetch

    const error = yield* Effect.promise(() =>
      runtimeFetch("https://provider.example").then(
        () => undefined,
        (cause) => cause,
      ),
    )
    yield* Effect.promise(() => Bun.sleep(40))

    expect(error).toBe(original)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)
  }),
)

it.live("runtime fetch starts case-insensitive SSE timeouts only when downstream reads", () =>
  Effect.gen(function* () {
    const cancellations: unknown[] = []
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const options = applyRuntimeFetch({
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
    const runtimeFetch = options.fetch as typeof fetch
    const response = yield* Effect.promise(() => runtimeFetch("https://provider.example"))

    yield* Effect.promise(() => Bun.sleep(40))
    controllers[0].enqueue(new TextEncoder().encode(": keepalive\n\n"))
    const reader = response.body!.getReader()
    const first = yield* Effect.promise(() => reader.read())
    const error = yield* Effect.promise(() => reader.read().then(undefined, (cause: unknown) => cause))

    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect((error as Error).message).toBe("SSE read timed out")
    expect(cancellations).toEqual([error])
  }),
)

it.live("runtime fetch times out JSON, NDJSON, Bedrock, binary, and untyped bodies after bytes", () =>
  Effect.gen(function* () {
    const sources = new Map<string, ReturnType<typeof pendingResponse>>(
      bodyTypes.map(([name, contentType]) => [name, pendingResponse(contentType)]),
    )
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 100,
      fetch: (input: RequestInfo | URL) => {
        const source = sources.get(new URL(String(input)).searchParams.get("case") ?? "")
        if (!source) throw new Error("unknown response body case")
        return Promise.resolve(source.response)
      },
    }).fetch as typeof fetch

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

          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          expect((error as Error).message).toBe("Provider response stream timed out")
          expect(source.cancellations()).toEqual([error])
        }),
      ),
    )
  }),
)

it.live("runtime fetch leaves an unread body idle until downstream pulls", () =>
  Effect.gen(function* () {
    const source = pendingResponse("application/json")
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 20,
      fetch: () => Promise.resolve(source.response),
    }).fetch as typeof fetch
    const response = yield* Effect.promise(() => runtimeFetch("https://provider.example"))

    yield* Effect.promise(() => Bun.sleep(40))
    expect(source.pulls()).toBe(0)
    expect(source.cancellations()).toEqual([])

    source.enqueue("available")
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe("available")
    const error = yield* Effect.promise(() => reader.read().then(undefined, (cause: unknown) => cause))
    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(source.cancellations()).toEqual([error])
  }),
)

it.live("runtime fetch keeps both clone branches alive when neither body is read before the timeout", () =>
  Effect.gen(function* () {
    const source = pendingResponse("application/json")
    let signal: AbortSignal | null | undefined
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 20,
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return Promise.resolve(source.response)
      },
    }).fetch as typeof fetch
    const response = yield* Effect.promise(() => runtimeFetch("https://provider.example"))
    const clone = response.clone()

    yield* Effect.promise(() => Bun.sleep(40))
    expect(signal?.aborted).toBe(false)
    expect(source.cancellations()).toEqual([])

    source.enqueue("complete")
    source.close()
    expect(yield* Effect.promise(() => Promise.all([response.text(), clone.text()]))).toEqual(["complete", "complete"])
  }),
)

it.live("runtime fetch preserves complete JSON and binary bytes plus response metadata through clone", () =>
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
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 1_000,
      fetch: (input: RequestInfo | URL) =>
        Promise.resolve(responses.get(new URL(String(input)).searchParams.get("case") ?? "")!),
    }).fetch as typeof fetch

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

it.live("runtime fetch keeps a cloned response alive until every branch is canceled", () =>
  Effect.gen(function* () {
    const source = pendingResponse("application/octet-stream")
    let signal: AbortSignal | null | undefined
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 1_000,
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return Promise.resolve(source.response)
      },
    }).fetch as typeof fetch
    const response = yield* Effect.promise(() => runtimeFetch("https://provider.example"))
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

it.live("runtime fetch shares a body timeout across active and not-yet-read clone branches", () =>
  Effect.gen(function* () {
    const source = pendingResponse("application/json")
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 20,
      fetch: () => Promise.resolve(source.response),
    }).fetch as typeof fetch
    const response = yield* Effect.promise(() => runtimeFetch("https://provider.example"))
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

    expect(originalError).toBeInstanceOf(ProviderError.ResponseStreamError)
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

it.live("runtime fetch returns the original response when body wrapping is disabled or impossible", () =>
  Effect.gen(function* () {
    const disabledResponse = new Response("disabled")
    const disabledFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: false,
      fetch: () => Promise.resolve(disabledResponse),
    }).fetch as typeof fetch
    expect(yield* Effect.promise(() => disabledFetch("https://provider.example"))).toBe(disabledResponse)

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
    const runtimeFetch = applyRuntimeFetch({
      headerTimeout: false,
      chunkTimeout: 20,
      fetch: (input: RequestInfo | URL) =>
        Promise.resolve(responses.get(new URL(String(input)).searchParams.get("case") ?? "")!),
    }).fetch as typeof fetch
    yield* Effect.promise(() =>
      Promise.all(
        Array.from(responses, async ([name, response]) => {
          expect(await runtimeFetch(`https://provider.example?case=${name}`)).toBe(response)
        }),
      ),
    )
    yield* Effect.promise(() => lock.cancel())
  }),
)

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

async function delayedHeaderServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function delayedBodyServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    setTimeout(() => {
      res.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function stalledErrorBodyServer() {
  let requests = 0
  const server = createServer((_, res) => {
    requests += 1
    res.writeHead(500, { "content-type": "application/json" })
    res.flushHeaders()
    res.write('{"error":{"message":"partial')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
  }
}

function withAuthContent<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown> = defaultAuthContent()) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function defaultAuthContent() {
  return {
    openai: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
  }
}
