import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { APICallError, jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Stream } from "effect"
import { LLMAIProcess, type AIProcessInput, type PoolOptions } from "@/session/llm/ai-process-client"
import type { AISDKEvent } from "@/session/llm/ai-sdk"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"

const pools = new Set<ReturnType<typeof LLMAIProcess.createPool>>()
const processes = new Set<number>()
const servers: Bun.Server<unknown>[] = []
const workerFixture = new URL("../fixture/ai-process-pool-worker.ts", import.meta.url).pathname
const parentFixture = new URL("../fixture/ai-process-pool-parent.ts", import.meta.url).pathname

afterEach(async () => {
  await Promise.allSettled([...pools].map((pool) => pool.close()))
  pools.clear()
  servers.splice(0).map((server) => server.stop(true))
  for (const pid of processes) {
    if (running(pid)) process.kill(pid, "SIGKILL")
  }
  processes.clear()
})

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error(message)
}

async function waitStopped(pid: number) {
  await waitFor(() => !running(pid), `Process ${pid} did not exit`)
  processes.delete(pid)
}

async function markers(state: string, pattern: string) {
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: state }))
}

function createPool(state: string, options: Omit<PoolOptions, "command"> = {}) {
  const observe = options.onSpawn
  const pool = LLMAIProcess.createPool({
    idleMs: 60_000,
    killGraceMs: 25,
    ...options,
    command: [process.execPath, workerFixture, state],
    onSpawn(info) {
      processes.add(info.pid)
      observe?.(info)
    },
  })
  pools.add(pool)
  return pool
}

type Directive = {
  action?:
    | "normal"
    | "gate"
    | "hang"
    | "crash"
    | "stderr"
    | "stderr-after-ready"
    | "gate-crash"
    | "ignore-term"
    | "end-no-ready"
    | "end-eof"
    | "wrong-run"
    | "error-frame"
    | "late-event"
    | "late-tool-a"
    | "late-tool-b"
  label?: string
  started?: string
  release?: string
  stderr?: string
  written?: string
  frame?: Record<string, unknown>
}

function fixtureInput(
  directive: Directive,
  options: {
    baseURL?: string
    apiKey?: string
    headers?: Record<string, string>
    tools?: AIProcessInput["tools"]
    extraOptions?: Record<string, unknown>
    providerOptions?: Record<string, unknown>
  } = {},
) {
  const baseURL = options.baseURL ?? "http://127.0.0.1:1/v1"
  const model = ProviderTest.model({
    id: ModelV2.ID.make("pool-model"),
    providerID: ProviderV2.ID.make("pool"),
    api: { id: "pool-model", url: baseURL, npm: "@ai-sdk/openai-compatible" },
  })
  return {
    provider: "pool",
    package: "@ai-sdk/openai-compatible",
    model: "pool-model",
    options: { baseURL, apiKey: options.apiKey ?? "pool-key", ...options.extraOptions },
    modelInfo: model,
    messageTransformOptions: {},
    messages: [{ role: "user", content: JSON.stringify(directive) }] satisfies ModelMessage[],
    tools: options.tools ?? {},
    activeTools: Object.keys(options.tools ?? {}),
    headers: options.headers ?? { "x-pool-affinity": "stable" },
    providerOptions: options.providerOptions,
    maxRetries: 0,
  } satisfies AIProcessInput
}

async function collect(
  pool: ReturnType<typeof LLMAIProcess.createPool>,
  input: AIProcessInput,
  tools: Record<string, Tool> = {},
  abort = new AbortController().signal,
) {
  const watchdog = new AbortController()
  const timer = setTimeout(() => watchdog.abort(), 8_000)
  const signal = AbortSignal.any([abort, watchdog.signal])
  try {
    return [
      ...(await Effect.runPromise(
        LLMAIProcess.stream(input, tools, input.messages, signal, { pool, killGraceMs: 25 }).pipe(Stream.runCollect),
      )),
    ]
  } finally {
    clearTimeout(timer)
  }
}

type FixtureRecord = {
  pid: number
  run: number
  label?: string
  state?: string
  providerInitializations?: number
  options?: unknown
  providerOptions?: unknown
  headers?: unknown
  tools?: unknown
  unexpected?: unknown[]
  result?: unknown
}

function records(events: AISDKEvent[]) {
  return events.filter((event) => event.type === "text-delta").map((event) => JSON.parse(event.text) as FixtureRecord)
}

function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-pool",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  }
}

function providerServer(
  response: unknown[],
  requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }>,
) {
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      requests.push({
        body: await request.text(),
        headers: request.headers,
        remotePort: server.requestIP(request)?.port,
      })
      return new Response(
        response.map((value) => `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  servers.push(server)
  return server
}

describe("LLM AI process pool", () => {
  test("reuses one process and one provider initialization for compatible serial turns", async () => {
    await using tmp = await tmpdir()
    const spawned: Array<{ pid: number; pooled: boolean }> = []
    const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info) })

    expect(await markers(tmp.path, "spawn-*")).toHaveLength(0)
    expect(await markers(tmp.path, "provider-*")).toHaveLength(0)
    const first = records(await collect(pool, fixtureInput({ label: "A" })))[0]
    expect(await markers(tmp.path, "spawn-*")).toHaveLength(1)
    expect(await markers(tmp.path, "provider-*")).toHaveLength(1)
    const second = records(await collect(pool, fixtureInput({ label: "B" })))[0]

    expect(first.pid).toBe(second.pid)
    expect(first.providerInitializations).toBe(1)
    expect(second.providerInitializations).toBe(1)
    expect(first.label).toBe("A")
    expect(second.label).toBe("B")
    expect(first.unexpected).toEqual([])
    expect(second.unexpected).toEqual([])
    expect(await markers(tmp.path, "spawn-*")).toHaveLength(1)
    expect(await markers(tmp.path, "provider-*")).toHaveLength(1)
    expect(spawned).toEqual([{ pid: first.pid, pooled: true }])
    expect(pool.stats()).toMatchObject({ pooled: 1, idle: 1, busy: 0, spawned: 1, reused: 1, oneShot: 0 })
  })

  test("accepts the next run immediately after ready without an ownership race", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 1, maxUses: 200 })
    const pids: number[] = []
    for (let index = 0; index < 100; index++) {
      pids.push(records(await collect(pool, fixtureInput({ label: String(index) })))[0].pid)
    }

    expect(new Set(pids).size).toBe(1)
    expect(await markers(tmp.path, "spawn-*")).toHaveLength(1)
    expect(pool.stats()).toMatchObject({ spawned: 1, reused: 99, pooled: 1, idle: 1, busy: 0 })
  }, 20_000)

  test("accepts immediate serial ready handoffs in the real runtime worker", async () => {
    const requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }> = []
    const server = providerServer(
      [chunk({ role: "assistant" }), chunk({ content: "ok" }), chunk({}, "stop"), "[DONE]"],
      requests,
    )
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      maxUses: 100,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    for (let index = 0; index < 50; index++) {
      const input = fixtureInput(
        { label: String(index) },
        { baseURL: `${server.url}v1`, apiKey: "ready-key", headers: { "x-ready": "stable" } },
      )
      const events = await collect(pool, input)
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("ok")
    }

    expect(requests).toHaveLength(50)
    expect(new Set(spawned).size).toBe(1)
    expect(pool.stats()).toMatchObject({ spawned: 1, reused: 49, pooled: 1, idle: 1, busy: 0 })
  }, 30_000)

  test("keeps generic provider error events visible and reuses the real runtime worker", async () => {
    const requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }> = []
    const server = providerServer(
      [{ error: { message: "generic provider error", type: "invalid_request_error" } }, chunk({}, "stop"), "[DONE]"],
      requests,
    )
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    const request = fixtureInput(
      { label: "generic-error" },
      { baseURL: `${server.url}v1`, apiKey: "error-key", headers: { "x-error": "stable" } },
    )

    const first = await collect(pool, request)
    const second = await collect(pool, request)

    expect(first).toContainEqual({
      type: "error",
      error: { message: "generic provider error", type: "invalid_request_error" },
    })
    expect(second).toContainEqual({
      type: "error",
      error: { message: "generic provider error", type: "invalid_request_error" },
    })
    expect(requests).toHaveLength(2)
    expect(spawned).toHaveLength(1)
    expect(pool.stats()).toMatchObject({ spawned: 1, reused: 1, pooled: 1, idle: 1, busy: 0 })
  })

  test("reconstructs API timeout frames while preserving HTTP retry classification", async () => {
    await using tmp = await tmpdir()
    const cases = [
      { statusCode: 400, isRetryable: false, expected: "APIError", expectedRetryable: false },
      { statusCode: 401, isRetryable: false, expected: "APIError", expectedRetryable: false },
      { statusCode: 500, isRetryable: true, expected: "APIError", expectedRetryable: true },
      { statusCode: 200, isRetryable: false, expected: "APIError", expectedRetryable: true },
      { statusCode: 413, isRetryable: false, expected: "ContextOverflowError", expectedRetryable: false },
    ] as const

    await Promise.all(
      cases.map(async ({ statusCode, isRetryable, expected, expectedRetryable }) => {
        const spawned: number[] = []
        const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
        const request = fixtureInput({
          action: "error-frame",
          frame: {
            error: "Provider response stream timed out",
            kind: "response-stream",
            api: { statusCode, isRetryable },
          },
        })
        const error = await collect(pool, request).catch((cause) => cause)

        expect(APICallError.isInstance(error)).toBe(true)
        if (!APICallError.isInstance(error)) throw error
        expect(error.statusCode).toBe(statusCode)
        expect(error.isRetryable).toBe(isRetryable)
        expect(error.cause).toBeInstanceOf(ProviderError.ResponseStreamError)
        expect((error.cause as Error).message).toBe("Provider response stream timed out")
        const result = MessageV2.fromError(error, { providerID: request.modelInfo.providerID })
        expect(result.name).toBe(expected)
        if (result.name === "APIError") expect(result.data.isRetryable).toBe(expectedRetryable)
        expect(spawned).toHaveLength(1)
        await waitStopped(spawned[0])
      }),
    )
  })

  test("rejects malformed API timeout frames and retires their workers", async () => {
    await using tmp = await tmpdir()
    const frames = [
      { error: "bad api without kind", api: { isRetryable: true } },
      { error: "bad api extra", kind: "response-stream", api: { isRetryable: true, extra: true } },
      { error: "bad api missing retryable", kind: "response-stream", api: { statusCode: 500 } },
      { error: "bad api retryable", kind: "response-stream", api: { isRetryable: "yes" } },
      { error: "bad api low status", kind: "response-stream", api: { statusCode: 99, isRetryable: true } },
      { error: "bad api high status", kind: "response-stream", api: { statusCode: 600, isRetryable: true } },
      { error: "bad api fractional status", kind: "response-stream", api: { statusCode: 500.5, isRetryable: true } },
    ]

    await Promise.all(
      frames.map(async (frame) => {
        const spawned: number[] = []
        const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
        const error = await collect(pool, fixtureInput({ action: "error-frame", frame })).catch((cause) => cause)

        expect(error).toBeInstanceOf(Error)
        expect(APICallError.isInstance(error)).toBe(false)
        expect((error as Error).message).toContain("Invalid or stale LLM process event")
        expect(spawned).toHaveLength(1)
        await waitStopped(spawned[0])
      }),
    )
  })

  test("reconstructs a response stream timeout and replaces the unhealthy real runtime worker", async () => {
    let stalled = true
    let requests = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.text()
        requests++
        if (stalled)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
              },
              pull: () => new Promise<void>(() => {}),
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        return new Response(
          [chunk({ role: "assistant" }), chunk({ content: "recovered" }), chunk({}, "stop"), "[DONE]"]
            .map((value) => `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    const request = fixtureInput(
      { label: "stream-timeout" },
      {
        baseURL: `${server.url}v1`,
        apiKey: "timeout-key",
        headers: { "x-timeout": "stable" },
        extraOptions: { chunkTimeout: 30 },
      },
    )

    const error = await collect(pool, request).catch((cause) => cause)

    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect((error as Error).message).toBe("SSE read timed out")
    expect(spawned).toHaveLength(1)
    await waitStopped(spawned[0])

    stalled = false
    const recovered = await collect(pool, request)

    expect(recovered.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["recovered"])
    expect(requests).toBe(2)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).not.toBe(spawned[0])
    expect(pool.stats()).toMatchObject({ spawned: 2, pooled: 1, idle: 1, busy: 0 })
    expect(pool.stats().retired).toBeGreaterThanOrEqual(1)
  }, 15_000)

  test("reconstructs JSON error-body timeouts with HTTP status before replacing the worker", async () => {
    const cases = [
      { statusCode: 500, isRetryable: true, expected: "APIError" },
      { statusCode: 413, isRetryable: false, expected: "ContextOverflowError" },
    ] as const
    await Promise.all(
      cases.map(async ({ statusCode, isRetryable, expected }) => {
        let stalled = true
        let requests = 0
        let canceled = 0
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            await request.text()
            requests++
            if (stalled)
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"error":{"message":"partial'))
                  },
                  pull: () => new Promise<void>(() => {}),
                  cancel() {
                    canceled++
                  },
                }),
                { status: statusCode, headers: { "content-type": "application/json" } },
              )
            return new Response(
              [chunk({ role: "assistant" }), chunk({ content: "recovered" }), chunk({}, "stop"), "[DONE]"]
                .map((value) => `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
        servers.push(server)
        const spawned: number[] = []
        const pool = LLMAIProcess.createPool({
          max: 1,
          idleMs: 60_000,
          killGraceMs: 25,
          onSpawn(info) {
            spawned.push(info.pid)
            processes.add(info.pid)
          },
        })
        pools.add(pool)
        const request = fixtureInput(
          { label: `json-error-timeout-${statusCode}` },
          {
            baseURL: `${server.url}v1`,
            apiKey: "timeout-key",
            headers: { "x-timeout": "stable" },
            extraOptions: { chunkTimeout: 30 },
          },
        )

        const error = await collect(pool, request).catch((cause) => cause)

        expect(APICallError.isInstance(error)).toBe(true)
        if (!APICallError.isInstance(error)) throw error
        expect(error.statusCode).toBe(statusCode)
        expect(error.isRetryable).toBe(isRetryable)
        expect(error.cause).toBeInstanceOf(ProviderError.ResponseStreamError)
        expect((error.cause as Error).message).toBe("Provider response stream timed out")
        expect(MessageV2.fromError(error, { providerID: request.modelInfo.providerID }).name).toBe(expected)
        expect(requests).toBe(1)
        expect(spawned).toHaveLength(1)
        await waitStopped(spawned[0])
        await waitFor(() => canceled === 1, `JSON ${statusCode} response producer was not canceled`)

        stalled = false
        const recovered = await collect(pool, request)

        expect(recovered.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
          "recovered",
        ])
        expect(requests).toBe(2)
        expect(spawned).toHaveLength(2)
        expect(spawned[1]).not.toBe(spawned[0])
        expect(pool.stats()).toMatchObject({ spawned: 2, pooled: 1, idle: 1, busy: 0 })
        expect(pool.stats().retired).toBeGreaterThanOrEqual(1)
      }),
    )
  }, 15_000)

  test("reconstructs a header timeout with its duration and replaces the unhealthy worker", async () => {
    let stalled = true
    let requests = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.text()
        requests++
        if (stalled) return new Promise<Response>(() => {})
        return new Response(
          [chunk({ role: "assistant" }), chunk({ content: "recovered" }), chunk({}, "stop"), "[DONE]"]
            .map((value) => `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    const request = fixtureInput(
      { label: "header-timeout" },
      {
        baseURL: `${server.url}v1`,
        apiKey: "timeout-key",
        headers: { "x-timeout": "stable" },
        extraOptions: { headerTimeout: 100, chunkTimeout: false },
      },
    )

    const error = await collect(pool, request).catch((cause) => cause)

    expect(error).toBeInstanceOf(ProviderError.HeaderTimeoutError)
    expect((error as ProviderError.HeaderTimeoutError).ms).toBe(100)
    expect((error as Error).message).toBe("Provider response headers timed out after 100ms")
    expect(spawned).toHaveLength(1)
    await waitStopped(spawned[0])

    stalled = false
    const recovered = await collect(pool, request)

    expect(recovered.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["recovered"])
    expect(requests).toBe(2)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).not.toBe(spawned[0])
    expect(pool.stats()).toMatchObject({ spawned: 2, pooled: 1, idle: 1, busy: 0 })
    expect(pool.stats().retired).toBeGreaterThanOrEqual(1)
  }, 15_000)

  test("reuses the real runtime worker across repeated completed tool turns", async () => {
    const requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }> = []
    const server = providerServer(
      [
        chunk({ role: "assistant" }),
        chunk({
          tool_calls: [{ index: 0, id: "call-ready", type: "function", function: { name: "fixture", arguments: "" } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"run":1}' } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ],
      requests,
    )
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      maxUses: 50,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    for (let index = 0; index < 25; index++) {
      const current = String(index)
      const currentTool = tool<{ run: number }, string>({
        inputSchema: jsonSchema({
          type: "object",
          properties: { run: { type: "number" } },
          required: ["run"],
        }),
        execute: async () => {
          if (index === 0) await Bun.sleep(100)
          return current
        },
      })
      const processTools = LLMAIProcess.prepareTools({ fixture: currentTool })
      if (!processTools) throw new Error("Expected process-safe repeated tool")
      const input = fixtureInput(
        { label: current },
        {
          baseURL: `${server.url}v1`,
          apiKey: "tool-ready-key",
          headers: { "x-tool-ready": "stable" },
          extraOptions: { chunkTimeout: 20 },
          tools: processTools,
        },
      )
      const events = await collect(pool, input, { fixture: currentTool })
      expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", output: current }))
    }

    expect(requests).toHaveLength(25)
    expect(new Set(spawned).size).toBe(1)
    expect(pool.stats()).toMatchObject({ spawned: 1, reused: 24, pooled: 1, idle: 1, busy: 0 })
  }, 30_000)

  test("isolates every option and header key without leaking values", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 4 })
    const configurations = [
      { label: "base", baseURL: "http://127.0.0.1:1001/v1", apiKey: "key-a", headers: { "x-session": "A" } },
      { label: "header", baseURL: "http://127.0.0.1:1001/v1", apiKey: "key-a", headers: { "x-session": "B" } },
      { label: "key", baseURL: "http://127.0.0.1:1001/v1", apiKey: "key-b", headers: { "x-session": "A" } },
      { label: "endpoint", baseURL: "http://127.0.0.1:1002/v1", apiKey: "key-a", headers: { "x-session": "A" } },
    ]
    const output = []
    for (const configuration of configurations) {
      output.push(
        records(
          await collect(
            pool,
            fixtureInput(
              { label: configuration.label },
              { baseURL: configuration.baseURL, apiKey: configuration.apiKey, headers: configuration.headers },
            ),
          ),
        )[0],
      )
    }

    expect(new Set(output.map((item) => item.pid)).size).toBe(4)
    expect(output.map((item) => item.headers)).toEqual(configurations.map((item) => item.headers))
    expect(output.map((item) => item.options)).toEqual(
      configurations.map((item) => ({ baseURL: item.baseURL, apiKey: item.apiKey })),
    )
    expect(await markers(tmp.path, "spawn-*")).toHaveLength(4)
  })

  test("canonicalizes nested options while keeping provider options lease-local", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 2 })
    const first = records(
      await collect(
        pool,
        fixtureInput(
          { label: "first" },
          {
            extraOptions: { nested: { alpha: 1, beta: { first: true, second: [1, 2, 3] } } },
            providerOptions: { pool: { value: "A" } },
          },
        ),
      ),
    )[0]
    const reordered = records(
      await collect(
        pool,
        fixtureInput(
          { label: "reordered" },
          {
            extraOptions: { nested: { beta: { second: [1, 2, 3], first: true }, alpha: 1 } },
            providerOptions: { pool: { value: "B" } },
          },
        ),
      ),
    )[0]
    const changed = records(
      await collect(
        pool,
        fixtureInput(
          { label: "changed" },
          {
            extraOptions: { nested: { alpha: 1, beta: { first: true, second: [1, 2, 4] } } },
            providerOptions: { pool: { value: "C" } },
          },
        ),
      ),
    )[0]

    expect(reordered.pid).toBe(first.pid)
    expect(reordered.providerOptions).toEqual({ pool: { value: "B" } })
    expect(reordered.providerOptions).not.toEqual(first.providerOptions)
    expect(changed.pid).not.toBe(first.pid)
  })

  test("does not collide a binary option with a similarly shaped plain object", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 2 })
    const bytes = Uint8Array.of(0, 1, 127, 255)
    const first = records(
      await collect(pool, fixtureInput({ label: "binary" }, { extraOptions: { collision: bytes } })),
    )[0]
    const second = records(
      await collect(
        pool,
        fixtureInput(
          { label: "object" },
          { extraOptions: { collision: { bytes: Buffer.from(bytes).toString("base64") } } },
        ),
      ),
    )[0]

    expect(second.pid).not.toBe(first.pid)
    expect(pool.stats()).toMatchObject({ pooled: 2, idle: 2, busy: 0, reused: 0 })
  })

  test("does not collide sparse arrays with holes at different positions", async () => {
    await using tmp = await tmpdir()
    const left = Array<string | undefined>(2)
    const right = Array<string | undefined>(2)
    left[1] = "x"
    right[0] = "x"
    const pool = createPool(tmp.path, { max: 2 })

    const first = records(
      await collect(pool, fixtureInput({ label: "left-hole" }, { extraOptions: { sparse: left } })),
    )[0]
    const second = records(
      await collect(pool, fixtureInput({ label: "right-hole" }, { extraOptions: { sparse: right } })),
    )[0]
    expect(second.pid).not.toBe(first.pid)
    expect(pool.stats()).toMatchObject({ pooled: 2, idle: 2, busy: 0, reused: 0 })
  })

  test("reuses the real worker without message or tool state leaking and keeps the connection alive", async () => {
    const requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }> = []
    const server = providerServer(
      [
        chunk({ role: "assistant" }),
        chunk({
          tool_calls: [{ index: 0, id: "call-pool", type: "function", function: { name: "fixture", arguments: "" } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"run":1}' } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ],
      requests,
    )
    const spawned: Array<{ pid: number; pooled: boolean }> = []
    const pool = LLMAIProcess.createPool({
      max: 1,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    const makeTool = (value: string) =>
      tool<{ run: number }, string>({
        inputSchema: jsonSchema({
          type: "object",
          properties: { run: { type: "number" } },
          required: ["run"],
        }),
        execute: async () => value,
      })
    const toolA = makeTool("TOOL_RESULT_A")
    const processA = LLMAIProcess.prepareTools({ fixture: toolA })
    if (!processA) throw new Error("Expected process-safe A tool")
    const inputA = fixtureInput(
      { label: "MESSAGE_SECRET_A" },
      {
        baseURL: `${server.url}v1`,
        apiKey: "stable-key",
        headers: { "x-pool-header": "stable" },
        tools: processA,
      },
    )
    const first = await collect(pool, inputA, { fixture: toolA })

    const toolB = makeTool("TOOL_RESULT_B")
    const processB = LLMAIProcess.prepareTools({ fixture: toolB })
    if (!processB) throw new Error("Expected process-safe B tool")
    const inputB = fixtureInput(
      { label: "MESSAGE_B" },
      {
        baseURL: `${server.url}v1`,
        apiKey: "stable-key",
        headers: { "x-pool-header": "stable" },
        tools: processB,
      },
    )
    const second = await collect(pool, inputB, { fixture: toolB })

    expect(requests).toHaveLength(2)
    expect(requests[0].body).toContain("MESSAGE_SECRET_A")
    expect(requests[1].body).toContain("MESSAGE_B")
    expect(requests[1].body).not.toContain("MESSAGE_SECRET_A")
    expect(requests.map((request) => request.headers.get("x-pool-header"))).toEqual(["stable", "stable"])
    expect(first).toContainEqual(expect.objectContaining({ type: "tool-result", output: "TOOL_RESULT_A" }))
    expect(second).toContainEqual(expect.objectContaining({ type: "tool-result", output: "TOOL_RESULT_B" }))
    expect(second).not.toContainEqual(expect.objectContaining({ type: "tool-result", output: "TOOL_RESULT_A" }))
    expect(spawned).toHaveLength(1)
    expect(spawned[0].pooled).toBeTrue()
    expect(requests[0].remotePort).toBeDefined()
    expect(requests[1].remotePort).toBe(requests[0].remotePort)
  })

  test("uses distinct real workers when credentials or headers differ", async () => {
    const requests: Array<{ body: string; headers: Headers; remotePort: number | undefined }> = []
    const server = providerServer([chunk({ role: "assistant" }), chunk({}, "stop"), "[DONE]"], requests)
    const spawned: number[] = []
    const pool = LLMAIProcess.createPool({
      max: 3,
      idleMs: 60_000,
      killGraceMs: 25,
      onSpawn(info) {
        spawned.push(info.pid)
        processes.add(info.pid)
      },
    })
    pools.add(pool)
    const first = fixtureInput(
      { label: "A" },
      { baseURL: `${server.url}v1`, apiKey: "credential-a", headers: { "x-session": "A", "x-affinity": "A" } },
    )
    const header = fixtureInput(
      { label: "B" },
      { baseURL: `${server.url}v1`, apiKey: "credential-a", headers: { "x-session": "B", "x-affinity": "A" } },
    )
    const credential = fixtureInput(
      { label: "C" },
      { baseURL: `${server.url}v1`, apiKey: "credential-c", headers: { "x-session": "A", "x-affinity": "A" } },
    )
    await collect(pool, first)
    await collect(pool, header)
    await collect(pool, credential)

    expect(new Set(spawned).size).toBe(3)
    expect(requests.map((request) => request.headers.get("x-session"))).toEqual(["A", "B", "A"])
    expect(requests.map((request) => request.headers.get("x-affinity"))).toEqual(["A", "A", "A"])
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer credential-a",
      "Bearer credential-a",
      "Bearer credential-c",
    ])
  })

  test("uses a reaped one-shot child when the matching pooled worker is busy", async () => {
    await using tmp = await tmpdir()
    const started = path.join(tmp.path, "started")
    const release = path.join(tmp.path, "release")
    const pool = createPool(tmp.path, { max: 1 })
    const first = collect(pool, fixtureInput({ action: "gate", label: "A", started, release }))
    await waitFor(() => Bun.file(started).exists(), "Pooled worker did not enter the gate")
    const pooledPID = Number(await Bun.file(started).text())

    const fallback = records(await collect(pool, fixtureInput({ label: "B" })))[0]
    expect(fallback.pid).not.toBe(pooledPID)
    await waitStopped(Number(fallback.pid))
    expect(pool.stats()).toMatchObject({ pooled: 1, idle: 0, busy: 1, oneShot: 1 })

    await Bun.write(release, "release")
    const completed = records(await first)
    expect(completed.at(-1)?.pid).toBe(pooledPID)
    expect(pool.stats()).toMatchObject({ pooled: 1, idle: 1, busy: 0, oneShot: 1 })
    expect(await markers(tmp.path, "spawn-*")).toHaveLength(2)
  })

  test("keeps the global pooled cap by replacing the least recently used idle key", async () => {
    await using tmp = await tmpdir()
    const spawned: Array<{ pid: number; pooled: boolean }> = []
    const pool = createPool(tmp.path, { max: 2, onSpawn: (info) => spawned.push(info) })
    const first = records(await collect(pool, fixtureInput({ label: "A" }, { headers: { "x-pool-affinity": "A" } })))[0]
    const second = records(
      await collect(pool, fixtureInput({ label: "B" }, { headers: { "x-pool-affinity": "B" } })),
    )[0]
    expect(running(Number(first.pid))).toBeTrue()
    expect(running(Number(second.pid))).toBeTrue()

    const third = records(await collect(pool, fixtureInput({ label: "C" }, { headers: { "x-pool-affinity": "C" } })))[0]
    await Promise.all([waitStopped(first.pid), waitStopped(third.pid)])
    expect(running(Number(second.pid))).toBeTrue()
    expect(spawned.slice(0, 3).map((info) => info.pooled)).toEqual([true, true, false])
    expect(pool.stats()).toMatchObject({ pooled: 1, idle: 1, busy: 0, oneShot: 1 })

    const fourth = records(
      await collect(pool, fixtureInput({ label: "C-again" }, { headers: { "x-pool-affinity": "C" } })),
    )[0]
    expect(spawned.at(-1)?.pooled).toBeTrue()
    expect(running(fourth.pid)).toBeTrue()
    expect(pool.stats()).toMatchObject({ pooled: 2, idle: 2, busy: 0, oneShot: 1 })
    expect(pool.stats().pooled).toBeLessThanOrEqual(2)
    expect([first, second, third, fourth].filter((item) => running(item.pid))).toHaveLength(2)
    expect(pool.stats().retired).toBeGreaterThanOrEqual(1)
  })

  test("counts a TERM-resistant retiring worker against the live pooled cap until it is reaped", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const spawned: Array<{ pid: number; pooled: boolean }> = []
    const pool = createPool(tmp.path, { max: 1, killGraceMs: 250, onSpawn: (info) => spawned.push(info) })
    const first = records(
      await collect(pool, fixtureInput({ action: "ignore-term", label: "A" }, { headers: { "x-pool-affinity": "A" } })),
    )[0]
    const fallback = records(
      await collect(pool, fixtureInput({ label: "B" }, { headers: { "x-pool-affinity": "B" } })),
    )[0]

    expect(spawned.slice(0, 2).map((info) => info.pooled)).toEqual([true, false])
    expect(fallback.pid).not.toBe(first.pid)
    await Promise.all([waitStopped(Number(first.pid)), waitStopped(Number(fallback.pid))])
    expect(pool.stats()).toMatchObject({ pooled: 0, oneShot: 1 })

    const replacement = records(
      await collect(pool, fixtureInput({ label: "C" }, { headers: { "x-pool-affinity": "B" } })),
    )[0]
    expect(spawned.at(-1)?.pooled).toBeTrue()
    expect(replacement.pid).not.toBe(first.pid)
  })

  test("does not let an old completed turn abort the next lease", async () => {
    await using tmp = await tmpdir()
    const started = path.join(tmp.path, "next-started")
    const release = path.join(tmp.path, "next-release")
    const pool = createPool(tmp.path, { max: 1 })
    const oldAbort = new AbortController()
    const first = records(await collect(pool, fixtureInput({ label: "A" }), {}, oldAbort.signal))[0]
    const next = collect(pool, fixtureInput({ action: "gate", label: "B", started, release }))
    await waitFor(() => Bun.file(started).exists(), "Next lease did not enter its gate")
    expect(Number(await Bun.file(started).text())).toBe(first.pid)

    oldAbort.abort()
    await Bun.write(release, "release")
    const second = records(await next).at(-1)
    expect(second?.pid).toBe(first.pid)
    expect(second?.label).toBe("B")
  })

  test("aborts, evicts, and reaps a busy worker without a cancel-frame leak", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 1 })
    const abort = new AbortController()
    const entered = Promise.withResolvers<number>()
    const input = fixtureInput({ action: "hang" })
    const runningTurn = Effect.runPromise(
      LLMAIProcess.stream(input, {}, input.messages, abort.signal, { pool, killGraceMs: 25 }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type !== "text-delta") return
            entered.resolve(Number((JSON.parse(event.text) as { pid: number }).pid))
          }),
        ),
        Stream.runDrain,
      ),
    )
    const pid = await entered.promise
    abort.abort()
    await expect(runningTurn).rejects.toThrow("Aborted")
    await waitStopped(pid)

    const replacement = records(await collect(pool, fixtureInput({ label: "replacement" })))[0]
    expect(replacement.pid).not.toBe(pid)
    expect(pool.stats().retired).toBeGreaterThanOrEqual(1)
  })

  test("rejects a stale event generation without exposing it to the next turn", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 1 })
    const first = records(await collect(pool, fixtureInput({ label: "A" })))[0]
    const seen: string[] = []
    const stale = fixtureInput({ action: "late-event" })
    const error = await Effect.runPromise(
      LLMAIProcess.stream(stale, {}, stale.messages, new AbortController().signal, { pool, killGraceMs: 25 }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "text-delta") seen.push(event.text)
          }),
        ),
      ),
    ).catch((error) => error)

    expect(error).toBeInstanceOf(Error)
    expect(seen).not.toContain("MUST_NOT_LEAK")
    await waitStopped(Number(first.pid))
    const replacement = records(await collect(pool, fixtureInput({ label: "C" })))[0]
    expect(replacement.pid).not.toBe(first.pid)
  })

  test("retires a lease with an outstanding tool before the tool ID can be reused", async () => {
    await using tmp = await tmpdir()
    const spawned: number[] = []
    const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
    const enteredA = Promise.withResolvers<void>()
    const releaseA = Promise.withResolvers<void>()
    const returningA = Promise.withResolvers<void>()
    const toolA = tool<{ run: number }, string>({
      inputSchema: jsonSchema({
        type: "object",
        properties: { run: { type: "number" } },
        required: ["run"],
      }),
      execute: async () => {
        enteredA.resolve()
        await releaseA.promise
        returningA.resolve()
        return "A-result"
      },
    })
    const processA = LLMAIProcess.prepareTools({ fixture: toolA })
    if (!processA) throw new Error("Expected process-safe fixture tool")
    const inputA = fixtureInput({ action: "late-tool-a" }, { tools: processA })
    const first = collect(pool, inputA, { fixture: toolA })
    await enteredA.promise
    const firstError = await first.catch((error) => error)
    expect(firstError).toBeInstanceOf(Error)
    expect(spawned).toHaveLength(1)
    await waitStopped(spawned[0])

    const enteredB = Promise.withResolvers<void>()
    const releaseB = Promise.withResolvers<void>()
    const toolB = tool<{ run: number }, string>({
      inputSchema: jsonSchema({
        type: "object",
        properties: { run: { type: "number" } },
        required: ["run"],
      }),
      execute: async () => {
        enteredB.resolve()
        await releaseB.promise
        return "B-result"
      },
    })
    const processB = LLMAIProcess.prepareTools({ fixture: toolB })
    if (!processB) throw new Error("Expected process-safe fixture tool")
    const inputB = fixtureInput({ action: "late-tool-b" }, { tools: processB })
    const second = collect(pool, inputB, { fixture: toolB })
    await enteredB.promise
    releaseA.resolve()
    await returningA.promise
    await Promise.resolve()
    await Promise.resolve()
    releaseB.resolve()

    const output = records(await second).at(-1)
    expect(output?.result).toMatchObject({ type: "tool-result", result: "B-result" })
    expect(output?.unexpected).toEqual([])
    expect(spawned).toHaveLength(2)
    expect(output?.pid).toBe(spawned[1])
    expect(spawned[1]).not.toBe(spawned[0])
  })

  test("treats EOF after end but before ready as an unhealthy lease", async () => {
    await using tmp = await tmpdir()
    const spawned: number[] = []
    const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
    const error = await collect(pool, fixtureInput({ action: "end-eof" })).catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(spawned).toHaveLength(1)
    await waitStopped(spawned[0])

    const replacement = records(await collect(pool, fixtureInput({ label: "replacement" })))[0]
    expect(replacement.pid).not.toBe(spawned[0])
  })

  test("times out and reaps a worker that sends end without ready", async () => {
    await using tmp = await tmpdir()
    const spawned: number[] = []
    const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
    const input = fixtureInput({ action: "end-no-ready" })
    const rescue = new AbortController()
    let rescued = false
    const timer = setTimeout(() => {
      rescued = true
      rescue.abort()
    }, 5_000)
    const error = await Effect.runPromise(
      LLMAIProcess.stream(input, {}, input.messages, rescue.signal, { pool, killGraceMs: 25 }).pipe(Stream.runDrain),
    ).catch((error) => error)
    clearTimeout(timer)

    expect(rescued).toBeFalse()
    expect(error).toBeInstanceOf(Error)
    expect(spawned).toHaveLength(1)
    await waitStopped(spawned[0])
  }, 8_000)

  test("evicts and reaps workers after a crash or malformed generation", async () => {
    await using tmp = await tmpdir()
    for (const action of ["crash", "wrong-run"] as const) {
      const spawned: number[] = []
      const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
      const error = await collect(pool, fixtureInput({ action })).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      const pid = spawned.at(-1)
      if (!pid) throw new Error(`Missing worker PID for ${action}`)
      await waitStopped(pid)
      const replacement = records(await collect(pool, fixtureInput({ label: `${action}-replacement` })))[0]
      expect(replacement.pid).not.toBe(pid)
      await pool.close()
      pools.delete(pool)
      await waitStopped(Number(replacement.pid))
    }
  }, 15_000)

  test("reaps a registered worker when the spawn observer throws", async () => {
    await using tmp = await tmpdir()
    const spawned: number[] = []
    const pool = createPool(tmp.path, {
      max: 1,
      onSpawn(info) {
        spawned.push(info.pid)
        throw new Error("observer failed")
      },
    })
    const error = await collect(pool, fixtureInput({ label: "observer" })).catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain("observer failed")
    expect(spawned).toHaveLength(1)

    await pool.close()
    pools.delete(pool)
    await waitStopped(spawned[0])
    expect(pool.stats()).toMatchObject({ pooled: 0, idle: 0, busy: 0 })
  })

  test("does not carry stderr diagnostics across lease boundaries", async () => {
    await using tmp = await tmpdir()
    const written = path.join(tmp.path, "stderr-written")
    const started = path.join(tmp.path, "crash-started")
    const release = path.join(tmp.path, "crash-release")
    const spawned: number[] = []
    const pool = createPool(tmp.path, { max: 1, onSpawn: (info) => spawned.push(info.pid) })
    const first = records(
      await collect(
        pool,
        fixtureInput({
          action: "stderr-after-ready",
          stderr: "SECRET_A_MUST_NOT_LEAK\n",
          written,
          label: "A",
        }),
      ),
    )[0]
    const crash = collect(pool, fixtureInput({ action: "gate-crash", started, release }))
    await waitFor(() => Bun.file(started).exists(), "Crash lease did not start")
    expect(Number(await Bun.file(started).text())).toBe(first.pid)
    await waitFor(() => Bun.file(written).exists(), "Previous lease did not write delayed stderr")
    await Bun.write(release, "crash")
    const error = await crash.catch((error) => error)

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw error
    expect(error.message).not.toContain("SECRET_A_MUST_NOT_LEAK")
    expect(spawned).toHaveLength(1)
    await waitStopped(Number(first.pid))
  })

  test("recycles on max uses, RSS, idle expiry, and an idle crash", async () => {
    await using tmp = await tmpdir()

    const uses = createPool(tmp.path, { max: 1, maxUses: 1 })
    const useA = records(await collect(uses, fixtureInput({ label: "use-a" })))[0]
    await waitStopped(Number(useA.pid))
    const useB = records(await collect(uses, fixtureInput({ label: "use-b" })))[0]
    expect(useB.pid).not.toBe(useA.pid)
    await uses.close()
    pools.delete(uses)
    await waitStopped(Number(useB.pid))

    const rss = createPool(tmp.path, { max: 1, maxRssBytes: 1 })
    const rssA = records(await collect(rss, fixtureInput({ label: "rss-a" })))[0]
    await waitStopped(Number(rssA.pid))
    const rssB = records(await collect(rss, fixtureInput({ label: "rss-b" })))[0]
    expect(rssB.pid).not.toBe(rssA.pid)
    await rss.close()
    pools.delete(rss)
    await waitStopped(Number(rssB.pid))

    const idle = createPool(tmp.path, { max: 1, idleMs: 25 })
    const idleA = records(await collect(idle, fixtureInput({ label: "idle-a" })))[0]
    await waitStopped(Number(idleA.pid))
    const idleB = records(await collect(idle, fixtureInput({ label: "idle-b" })))[0]
    expect(idleB.pid).not.toBe(idleA.pid)
    process.kill(Number(idleB.pid), "SIGKILL")
    await waitStopped(Number(idleB.pid))
    const idleC = records(await collect(idle, fixtureInput({ label: "idle-c" })))[0]
    expect(idleC.pid).not.toBe(idleB.pid)
  }, 20_000)

  test("disposes every idle worker without leaving an orphan", async () => {
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 2 })
    const first = records(await collect(pool, fixtureInput({ label: "first" })))[0]
    const second = records(
      await collect(pool, fixtureInput({ label: "second" }, { headers: { "x-pool-affinity": "second" } })),
    )[0]
    expect(first.pid).not.toBe(second.pid)

    await pool.close()
    pools.delete(pool)
    await Promise.all([waitStopped(Number(first.pid)), waitStopped(Number(second.pid))])
    expect(pool.stats()).toMatchObject({ pooled: 0, idle: 0, busy: 0 })
  })

  test("closes a busy turn and reaps its worker", async () => {
    await using tmp = await tmpdir()
    const started = path.join(tmp.path, "busy-started")
    const release = path.join(tmp.path, "never-release")
    const pool = createPool(tmp.path, { max: 1 })
    const turn = collect(pool, fixtureInput({ action: "gate", started, release }))
    await waitFor(() => Bun.file(started).exists(), "Busy worker did not enter the gate")
    const pid = Number(await Bun.file(started).text())

    await pool.close()
    pools.delete(pool)
    const error = await turn.catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    await waitStopped(pid)
    expect(pool.stats()).toMatchObject({ pooled: 0, idle: 0, busy: 0 })
  })

  test("closes and reaps both a pooled turn and its active one-shot fallback", async () => {
    await using tmp = await tmpdir()
    const pooledStarted = path.join(tmp.path, "pooled-started")
    const fallbackStarted = path.join(tmp.path, "fallback-started")
    const pool = createPool(tmp.path, { max: 1 })
    const pooled = collect(
      pool,
      fixtureInput({ action: "gate", started: pooledStarted, release: path.join(tmp.path, "pooled-release") }),
    ).catch((error) => error)
    await waitFor(() => Bun.file(pooledStarted).exists(), "Pooled close fixture did not start")
    const fallback = collect(
      pool,
      fixtureInput({ action: "gate", started: fallbackStarted, release: path.join(tmp.path, "fallback-release") }),
    ).catch((error) => error)
    await waitFor(() => Bun.file(fallbackStarted).exists(), "One-shot close fixture did not start")
    const pids = [Number(await Bun.file(pooledStarted).text()), Number(await Bun.file(fallbackStarted).text())]
    expect(new Set(pids).size).toBe(2)
    expect(pool.stats()).toMatchObject({ pooled: 1, busy: 1, oneShot: 1 })

    await pool.close()
    pools.delete(pool)
    const survivors = pids.filter(running)
    survivors.forEach((pid) => process.kill(pid, "SIGKILL"))
    await Promise.all(pids.map(waitStopped))
    const outcomes = await Promise.all([pooled, fallback])

    expect(survivors).toEqual([])
    expect(outcomes.every((outcome) => outcome instanceof Error)).toBeTrue()
    expect(pool.stats()).toMatchObject({ pooled: 0, idle: 0, busy: 0, oneShot: 1 })
  })

  test("makes concurrent and repeated close calls await the same complete reap", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const pool = createPool(tmp.path, { max: 1, killGraceMs: 250 })
    const metadata = records(await collect(pool, fixtureInput({ action: "ignore-term", label: "close" })))[0]
    const first = pool.close()
    let secondDone = false
    const second = pool.close().then(() => {
      secondDone = true
    })
    await Promise.resolve()

    expect(running(metadata.pid)).toBeTrue()
    expect(secondDone).toBeFalse()
    await Promise.all([first, second])
    pools.delete(pool)
    expect(running(metadata.pid)).toBeFalse()
    processes.delete(metadata.pid)
    await pool.close()
  })

  test.each(["natural", "dispose"] as const)(
    "does not keep a parent alive or leave an orphan after %s completion",
    async (mode) => {
      await using tmp = await tmpdir()
      const result = path.join(tmp.path, "result")
      const child = Bun.spawn([process.execPath, parentFixture, tmp.path, result, mode], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
        lazy: true,
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      let rescued = false
      const rescue = setTimeout(() => {
        if (child.exitCode !== null) return
        rescued = true
        child.kill("SIGKILL")
      }, 8_000)
      const exitCode = await child.exited
      clearTimeout(rescue)

      expect(rescued).toBeFalse()
      expect(exitCode, `${mode} stdout: ${await stdout}\n${mode} stderr: ${await stderr}`).toBe(0)
      const metadata = JSON.parse(await Bun.file(result).text()) as { pid: number }
      await waitStopped(metadata.pid)
    },
    10_000,
  )
})
