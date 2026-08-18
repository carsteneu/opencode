import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, streamText, tool, type ModelMessage, wrapLanguageModel } from "ai"
import { Effect, Stream } from "effect"
import { LLMAIProcess, type AIProcessInput } from "@/session/llm/ai-process-client"
import type { AISDKEvent } from "@/session/llm/ai-sdk"
import { LLMWorkerIPC } from "@/session/llm/ipc"
import { LLMMessageTransform } from "@/session/llm/message-transform"
import { blockedTools } from "@/session/llm/blocked-tools"
import { ProviderTest } from "../fake/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tmpdir } from "../fixture/fixture"

const servers: Bun.Server<unknown>[] = []
const fixtureProcesses = new Set<number>()
const workerFixture = new URL("../fixture/ai-process-worker.ts", import.meta.url).pathname
const runtimeWorker = new URL("../../src/session/llm/ai-process-worker.ts", import.meta.url).pathname

afterEach(() => {
  servers.splice(0).map((server) => server.stop(true))
  for (const pid of fixtureProcesses) {
    if (running(pid)) process.kill(pid, "SIGKILL")
  }
  fixtureProcesses.clear()
})

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function fixtureCommand(
  mode: "stderr-before-end" | "stderr-error" | "ignore-term" | "slow-output" | "initial-frame",
  ...args: string[]
) {
  return [process.execPath, workerFixture, mode, ...args]
}

function input(server: Bun.Server<unknown>, tools: AIProcessInput["tools"] = {}): AIProcessInput {
  const model = ProviderTest.model({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    api: { id: "test-model", url: `${server.url}v1`, npm: "@ai-sdk/openai-compatible" },
  })
  return {
    provider: "test",
    package: "@ai-sdk/openai-compatible",
    model: "test-model",
    options: { baseURL: `${server.url}v1`, apiKey: "test" },
    modelInfo: model,
    messageTransformOptions: {},
    messages: [{ role: "user", content: "hello" }],
    tools,
    activeTools: Object.keys(tools),
    headers: {},
    maxRetries: 0,
  }
}

function serve(
  lines: unknown[],
  delay = 0,
  inspect?: (request: Request) => void | Promise<void>,
  observe?: (index: number) => void,
) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await inspect?.(request)
      const body = new ReadableStream({
        async start(controller) {
          for (const [index, value] of lines.entries()) {
            observe?.(index)
            controller.enqueue(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`)
            if (delay) await Bun.sleep(delay)
          }
          controller.close()
        },
      })
      return new Response(body.pipeThrough(new TextEncoderStream()), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  servers.push(server)
  return server
}

function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  }
}

describe("LLM AI process", () => {
  test("drains stderr beyond pipe capacity before the worker writes stdout", async () => {
    const server = serve([])
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 8_000)
    try {
      const events = await Effect.runPromise(
        LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal, {
          command: fixtureCommand("stderr-before-end"),
          killGraceMs: 25,
        }).pipe(Stream.runCollect),
      )
      expect([...events]).toEqual([])
    } finally {
      clearTimeout(watchdog)
    }
  }, 10_000)

  test("retains only the bounded stderr tail when the worker exits unexpectedly", async () => {
    const server = serve([])
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 8_000)
    try {
      const error = await Effect.runPromise(
        LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal, {
          command: fixtureCommand("stderr-error"),
          killGraceMs: 25,
        }).pipe(Stream.runDrain),
      ).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw error
      expect(error.message).toContain("TAIL_SHOULD_SURVIVE")
      expect(error.message).not.toContain("PREFIX_SHOULD_BE_DROPPED")
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(64 * 1024)
    } finally {
      clearTimeout(watchdog)
    }
  }, 10_000)

  test("backpressures a fast worker while the stream consumer is gated without dropping frames", async () => {
    await using tmp = await tmpdir()
    const progress = path.join(tmp.path, "progress")
    const complete = path.join(tmp.path, "complete")
    const started = path.join(tmp.path, "started")
    const first = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const frameText = "x".repeat(64 * 1024)
    const received: string[] = []
    let contentsExact = true
    const server = serve([])
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 10_000)
    let pid = 0
    const consuming = Effect.runPromise(
      LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal, {
        command: fixtureCommand("slow-output", progress, complete, started),
        killGraceMs: 25,
      }).pipe(
        Stream.runForEach((event) =>
          Effect.promise(async () => {
            if (event.type !== "text-delta") return
            if (event.id !== "ready") {
              received.push(event.id)
              contentsExact = contentsExact && event.text === frameText
              return
            }
            pid = Number(event.text)
            fixtureProcesses.add(pid)
            first.resolve()
            await release.promise
          }),
        ),
      ),
    )

    let heldError: unknown
    try {
      expect(await Promise.race([first.promise.then(() => true), consuming.then(() => false)])).toBeTrue()
      for (let attempt = 0; attempt < 1_000 && !(await Bun.file(started).exists()); attempt++) {
        await Bun.sleep(5)
      }
      expect(await Bun.file(started).text()).toBe("started")

      let count = 0
      for (let attempt = 0; attempt < 1_000 && count < 1 && !(await Bun.file(complete).exists()); attempt++) {
        if (await Bun.file(progress).exists()) count = Number(await Bun.file(progress).text())
        if (count < 1) await Bun.sleep(5)
      }
      let stable = 0
      let previous = count
      while (stable < 5 && !(await Bun.file(complete).exists())) {
        await Bun.sleep(10)
        const current = Number(await Bun.file(progress).text())
        stable = current === previous ? stable + 1 : 0
        previous = current
      }
      expect(previous).toBeGreaterThanOrEqual(1)
      expect(previous).toBeLessThanOrEqual(2)
      expect(await Bun.file(complete).exists()).toBeFalse()
    } catch (error) {
      heldError = error
    } finally {
      release.resolve()
    }

    try {
      await consuming
    } finally {
      clearTimeout(watchdog)
    }
    if (heldError) throw heldError
    expect(received).toHaveLength(512)
    expect(received).toEqual(Array.from({ length: 512 }, (_, index) => `frame-${index}`))
    expect(contentsExact).toBeTrue()
    expect(await Bun.file(complete).text()).toBe("done")
    expect(running(pid)).toBeFalse()
    fixtureProcesses.delete(pid)
  }, 15_000)

  test("writes and acknowledges a 50 MiB initial worker frame", async () => {
    const server = serve([])
    const payload = "0123456789abcdef".repeat((50 * 1024 * 1024) / 16)
    const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex")
    const request = input(server)
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 15_000)
    try {
      const events = await Effect.runPromise(
        LLMAIProcess.stream(
          { ...request, options: { ...request.options, fixturePayload: payload } },
          {},
          [{ role: "user", content: "hello" }],
          abort.signal,
          { command: fixtureCommand("initial-frame"), killGraceMs: 25 },
        ).pipe(Stream.runCollect),
      )
      const acknowledgements = events.filter((event) => event.type === "text-delta")
      expect(acknowledgements.map((event) => event.text)).toEqual([`${payload.length}:${digest}`])
    } finally {
      clearTimeout(watchdog)
    }
  }, 20_000)

  test("streams through a child and coalesces text without changing content", async () => {
    const text = Array.from({ length: 80 }, (_, index) => String(index % 10))
    let firstDeltaAt = 0
    let lastDeltaAt = 0
    const server = serve(
      [chunk({ role: "assistant" }), ...text.map((value) => chunk({ content: value })), chunk({}, "stop"), "[DONE]"],
      4,
      undefined,
      (index) => {
        if (index === 1) firstDeltaAt = performance.now()
        if (index === text.length) lastDeltaAt = performance.now()
      },
    )
    const events = await Effect.runPromise(
      LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], new AbortController().signal).pipe(
        Stream.runCollect,
      ),
    )
    const deltas = events.filter((event) => event.type === "text-delta")
    expect(deltas.map((event) => event.text).join("")).toBe(text.join(""))
    // Producer sleeps stretch under host load, so derive the envelope bound
    // from the observed stream duration instead of assuming 80 * 4 ms.
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil((lastDeltaAt - firstDeltaAt) / 200) + 2)
    expect(events.some((event) => event.type === "finish")).toBeTrue()
  }, 10_000)

  test("emits the first delta immediately and coalesces following deltas in order", async () => {
    const following = Promise.withResolvers<void>()
    const encoder = new TextEncoder()
    let sent = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              const write = (value: unknown) =>
                controller.enqueue(encoder.encode(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`))
              write(chunk({ role: "assistant" }))
              sent = performance.now()
              write(chunk({ content: "A" }))
              await following.promise
              write(chunk({ content: "B" }))
              write(chunk({ content: "C" }))
              write(chunk({}, "stop"))
              write("[DONE]")
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 8_000)
    let latency = Number.POSITIVE_INFINITY
    try {
      const events = await Effect.runPromise(
        LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "text-delta" || latency !== Number.POSITIVE_INFINITY) return
              latency = performance.now() - sent
              following.resolve()
            }),
          ),
          Stream.runCollect,
        ),
      )
      const output = [...events]
      const deltas = output.filter((event) => event.type === "text-delta")
      expect(latency).toBeLessThan(175)
      expect(deltas.map((event) => event.text)).toEqual(["A", "BC"])
      expect(
        output
          .filter((event) => ["text-start", "text-delta", "text-end", "finish"].includes(event.type))
          .map((event) => event.type),
      ).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"])
    } finally {
      following.resolve()
      clearTimeout(watchdog)
    }
  }, 10_000)

  test("coalesces thousands of tool input fragments without changing parsed execution", async () => {
    const value = "x".repeat(16 * 1024 - Buffer.byteLength('{"value":""}'))
    const argument = JSON.stringify({ value })
    const fragments = Array.from({ length: 2_009 }, (_, index) =>
      argument.slice(
        Math.floor((index * argument.length) / 2_009),
        Math.floor(((index + 1) * argument.length) / 2_009),
      ),
    )
    expect(Buffer.byteLength(argument)).toBe(16 * 1024)
    expect(fragments.every((fragment) => fragment.length > 0)).toBeTrue()

    const release = Promise.withResolvers<void>()
    const firstObserved = Promise.withResolvers<void>()
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              const write = (value: unknown) =>
                controller.enqueue(encoder.encode(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`))
              write(chunk({ role: "assistant" }))
              write(
                chunk({
                  tool_calls: [
                    { index: 0, id: "call-fast", type: "function", function: { name: "capture", arguments: "" } },
                  ],
                }),
              )
              write(chunk({ tool_calls: [{ index: 0, function: { arguments: fragments[0] } }] }))
              await release.promise
              for (const fragment of fragments.slice(1)) {
                write(chunk({ tool_calls: [{ index: 0, function: { arguments: fragment } }] }))
              }
              write(chunk({}, "tool_calls"))
              write("[DONE]")
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)

    let executed: { value: string } | undefined
    const capture = tool<{ value: string }, number>({
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        executed = input
        return input.value.length
      },
    })
    const processTools = LLMAIProcess.prepareTools({ capture })
    if (!processTools) throw new Error("Expected tool to be safe for the AI process")
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 12_000)
    let firstDeltaAt = 0
    let inputEndAt = 0
    let output: AISDKEvent[] = []
    let visible = false
    try {
      const run = Effect.runPromise(
        LLMAIProcess.stream(
          input(server, processTools),
          { capture },
          [{ role: "user", content: "hello" }],
          abort.signal,
        ).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "tool-input-delta" && event.id === "call-fast" && firstDeltaAt === 0) {
                firstDeltaAt = performance.now()
                firstObserved.resolve()
              }
              if (event.type === "tool-input-end" && event.id === "call-fast") inputEndAt = performance.now()
            }),
          ),
          Stream.runCollect,
        ),
      )
      visible = await Promise.race([firstObserved.promise.then(() => true), Bun.sleep(8_000).then(() => false)])
      release.resolve()
      output = [...(await run)]
    } finally {
      release.resolve()
      clearTimeout(watchdog)
    }

    const deltas = output.flatMap((event) => {
      if (event.type !== "tool-input-delta" || event.id !== "call-fast") return []
      if (!("delta" in event) || typeof event.delta !== "string") return []
      return [event.delta]
    })
    const inputStart = output.findIndex((event) => event.type === "tool-input-start" && event.id === "call-fast")
    const firstDelta = output.findIndex((event) => event.type === "tool-input-delta" && event.id === "call-fast")
    const lastDelta = output.findLastIndex((event) => event.type === "tool-input-delta" && event.id === "call-fast")
    const inputEnd = output.findIndex((event) => event.type === "tool-input-end" && event.id === "call-fast")
    const toolCall = output.findIndex((event) => event.type === "tool-call" && event.toolCallId === "call-fast")
    const toolResult = output.findIndex((event) => event.type === "tool-result" && event.toolCallId === "call-fast")

    expect(visible).toBeTrue()
    expect(deltas[0]).toBe(fragments[0])
    expect(deltas.join("")).toBe(argument)
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil((inputEndAt - firstDeltaAt) / 200) + 2)
    expect(deltas.length).toBeLessThan(20)
    expect(executed).toEqual({ value })
    expect(inputStart).toBeLessThan(firstDelta)
    expect(firstDelta).toBeLessThanOrEqual(lastDelta)
    expect(lastDelta).toBeLessThan(inputEnd)
    expect(inputEnd).toBeLessThan(toolCall)
    expect(toolCall).toBeLessThan(toolResult)
  }, 15_000)

  test("bounds fast Unicode tool input frames by UTF-8 bytes", async () => {
    const unit = "🙂".repeat(128)
    const prefix = '{"value":"'
    const suffix = '"}'
    const fragments = [prefix, ...Array.from({ length: 320 }, () => unit), suffix]
    const argument = fragments.join("")
    const value = "🙂".repeat(40 * 1024)
    expect(argument).toBe(JSON.stringify({ value }))
    expect(Buffer.byteLength(value)).toBe(160 * 1024)

    const server = serve([
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [{ index: 0, id: "call-unicode", type: "function", function: { name: "capture", arguments: "" } }],
      }),
      ...fragments.map((fragment) => chunk({ tool_calls: [{ index: 0, function: { arguments: fragment } }] })),
      chunk({}, "tool_calls"),
      "[DONE]",
    ])
    let executed: { value: string } | undefined
    const capture = tool<{ value: string }, number>({
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        executed = input
        return Buffer.byteLength(input.value)
      },
    })
    const processTools = LLMAIProcess.prepareTools({ capture })
    if (!processTools) throw new Error("Expected tool to be safe for the AI process")
    const abort = new AbortController()
    const watchdog = setTimeout(() => abort.abort(), 12_000)
    let firstDeltaAt = 0
    let inputEndAt = 0
    let output: AISDKEvent[] = []
    try {
      output = [
        ...(await Effect.runPromise(
          LLMAIProcess.stream(
            input(server, processTools),
            { capture },
            [{ role: "user", content: "hello" }],
            abort.signal,
          ).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "tool-input-delta" && event.id === "call-unicode" && firstDeltaAt === 0) {
                  firstDeltaAt = performance.now()
                }
                if (event.type === "tool-input-end" && event.id === "call-unicode") inputEndAt = performance.now()
              }),
            ),
            Stream.runCollect,
          ),
        )),
      ]
    } finally {
      clearTimeout(watchdog)
    }

    const deltas = output.flatMap((event) => {
      if (event.type !== "tool-input-delta" || event.id !== "call-unicode") return []
      if (!("delta" in event) || typeof event.delta !== "string") return []
      return [event.delta]
    })
    const bytes = deltas.map((delta) => Buffer.byteLength(delta, "utf8"))
    const lastDelta = output.findLastIndex((event) => event.type === "tool-input-delta" && event.id === "call-unicode")
    const inputEnd = output.findIndex((event) => event.type === "tool-input-end" && event.id === "call-unicode")

    expect(deltas.join("")).toBe(argument)
    expect(bytes.reduce((total, size) => total + size, 0)).toBe(Buffer.byteLength(argument))
    expect(Math.max(...bytes)).toBeLessThanOrEqual(64 * 1024)
    expect(deltas.length).toBeGreaterThanOrEqual(4)
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil((inputEndAt - firstDeltaAt) / 200) + 4)
    expect(executed).toEqual({ value })
    expect(lastDelta).toBeGreaterThanOrEqual(0)
    expect(inputEnd).toBe(lastDelta + 1)
  }, 15_000)

  test("executes tools in the parent process", async () => {
    let requestBody: { tools?: Array<{ function?: { strict?: boolean } }> } = {}
    const server = serve(
      [
        chunk({ role: "assistant" }),
        chunk({
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: "" } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"value":"ok"}' } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ],
      0,
      async (request) => {
        requestBody = (await request.json()) as typeof requestBody
      },
    )
    let called = false
    let converted = false
    const echo = tool<{ value: string }, string>({
      title: "Echo",
      providerOptions: { test: { cacheKey: "stable" } },
      inputSchema: jsonSchema<{ value: string }>({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      }),
      inputExamples: [{ input: { value: "example" } }],
      needsApproval: false,
      strict: false,
      execute: async (value) => {
        called = true
        return value.value
      },
      toModelOutput({ output }) {
        converted = true
        return { type: "text", value: `converted:${output}` }
      },
    })
    const processTools = LLMAIProcess.prepareTools({ echo })
    expect(processTools?.echo).toMatchObject({
      title: "Echo",
      providerOptions: { test: { cacheKey: "stable" } },
      inputExamples: [{ input: { value: "example" } }],
      needsApproval: false,
      strict: false,
      toModelOutput: true,
    })
    if (!processTools) throw new Error("Expected tool to be safe for the AI process")
    const events = await Effect.runPromise(
      LLMAIProcess.stream(
        input(server, processTools),
        { echo },
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ).pipe(Stream.runCollect),
    )
    expect(called).toBeTrue()
    expect(converted).toBeTrue()
    expect(requestBody.tools?.[0]?.function?.strict).toBeFalse()
    expect(events.some((event) => event.type === "tool-result")).toBeTrue()
  })

  test("blocked tool execution preserves the AI process request without invoking source hooks", async () => {
    const bodies: string[] = []
    const baselineServer = serve([chunk({ role: "assistant" }), chunk({}, "stop"), "[DONE]"], 0, async (request) => {
      bodies.push(await request.text())
    })
    const blockedServer = serve(
      [
        chunk({ role: "assistant" }),
        chunk({
          tool_calls: [
            { index: 0, id: "call-blocked", type: "function", function: { name: "guarded", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"value":"unsafe"}' } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ],
      0,
      async (request) => {
        bodies.push(await request.text())
      },
    )
    const sideEffects = {
      execute: 0,
      inputStart: 0,
      inputDelta: 0,
      inputAvailable: 0,
      approval: 0,
      modelOutput: 0,
      inputValidate: 0,
      outputValidate: 0,
    }
    const guarded = tool<{ value: string }, { output: string }>({
      description: "Guarded process tool",
      title: "Guarded",
      providerOptions: { test: { cacheKey: "stable" } },
      inputSchema: jsonSchema(
        {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        {
          validate: (value) => {
            sideEffects.inputValidate++
            return { success: true, value: value as { value: string } }
          },
        },
      ),
      outputSchema: jsonSchema(
        { type: "object", properties: { output: { type: "string" } }, required: ["output"] },
        {
          validate: (value) => {
            sideEffects.outputValidate++
            return { success: true, value: value as { output: string } }
          },
        },
      ),
      inputExamples: [{ input: { value: "example" } }],
      strict: false,
      execute: async ({ value }) => {
        sideEffects.execute++
        return { output: value }
      },
      onInputStart() {
        sideEffects.inputStart++
      },
      onInputDelta() {
        sideEffects.inputDelta++
      },
      onInputAvailable() {
        sideEffects.inputAvailable++
      },
      needsApproval: async () => {
        sideEffects.approval++
        return false
      },
      toModelOutput: ({ output }) => {
        sideEffects.modelOutput++
        return { type: "text", value: output.output }
      },
    })
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const normal = streamText({
      model: createOpenAICompatible({
        name: "test",
        baseURL: `${baselineServer.url}v1`,
        apiKey: "test",
      })("test-model"),
      messages,
      tools: { guarded },
      maxRetries: 0,
    })
    for await (const _ of normal.fullStream) void _

    const blocked = await blockedTools({ guarded })
    const processTools = LLMAIProcess.prepareTools(blocked)
    if (!processTools) throw new Error("Expected blocked tools to be safe for the AI process")
    const events = await Effect.runPromise(
      LLMAIProcess.stream(input(blockedServer, processTools), blocked, messages, new AbortController().signal).pipe(
        Stream.runCollect,
      ),
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(sideEffects).toEqual({
      execute: 0,
      inputStart: 0,
      inputDelta: 0,
      inputAvailable: 0,
      approval: 0,
      modelOutput: 0,
      inputValidate: 0,
      outputValidate: 0,
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-error",
        toolCallId: "call-blocked",
        error: expect.objectContaining({ message: "Tool execution is disabled for this request" }),
      }),
    )
  })

  test("streams the tool call before parent execution completes", async () => {
    const server = serve([
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"value":"ok"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const observed = Promise.withResolvers<void>()
    const echo = tool<{ value: string }, string>({
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      }),
      execute: async (value) => {
        entered.resolve()
        await release.promise
        return value.value
      },
    })
    const processTools = LLMAIProcess.prepareTools({ echo })
    if (!processTools) throw new Error("Expected tool to be safe for the AI process")
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const events: string[] = []
    const run = Effect.runPromise(
      LLMAIProcess.stream(input(server, processTools), { echo }, messages, new AbortController().signal).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event.type)
            if (event.type === "tool-call") observed.resolve()
          }),
        ),
      ),
    )

    await entered.promise
    const visible = await Promise.race([observed.promise.then(() => true), Bun.sleep(2_000).then(() => false)])
    release.resolve()
    await run

    expect(visible).toBeTrue()
    expect(events.indexOf("tool-call")).toBeLessThan(events.indexOf("tool-result"))
  })

  test("starts parallel parent tools without blocking the worker reader", async () => {
    const server = serve([
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name: "first", arguments: "" } },
          { index: 1, id: "call-2", type: "function", function: { name: "second", arguments: "" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: "{}" } },
          { index: 1, function: { arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ])
    const entered = new Set<string>()
    const completed: string[] = []
    const both = Promise.withResolvers<void>()
    const secondCompleted = Promise.withResolvers<void>()
    const releases = {
      first: Promise.withResolvers<void>(),
      second: Promise.withResolvers<void>(),
    }
    const parentTool = (name: "first" | "second") =>
      tool<Record<string, never>, string>({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          entered.add(name)
          if (entered.size === 2) both.resolve()
          await releases[name].promise
          completed.push(name)
          if (name === "second") secondCompleted.resolve()
          return name
        },
      })
    const first = parentTool("first")
    const second = parentTool("second")
    const processTools = LLMAIProcess.prepareTools({ first, second })
    if (!processTools) throw new Error("Expected tools to be safe for the AI process")
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const events: AISDKEvent[] = []
    const run = Effect.runPromise(
      LLMAIProcess.stream(input(server, processTools), { first, second }, messages, new AbortController().signal).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
          }),
        ),
      ),
    )

    const concurrent = await Promise.race([both.promise.then(() => true), Bun.sleep(10_000).then(() => false)])
    releases.second.resolve()
    await secondCompleted.promise
    releases.first.resolve()
    await run

    expect(concurrent).toBeTrue()
    expect(entered).toEqual(new Set(["first", "second"]))
    expect(completed).toEqual(["second", "first"])
    expect(
      events
        .filter((event) => event.type === "tool-result")
        .map((event) => ({ callID: event.toolCallId, output: event.output })),
    ).toEqual([
      { callID: "call-2", output: "second" },
      { callID: "call-1", output: "first" },
    ])
  })

  test("aborts parent tool execution when the stream consumer stops", async () => {
    const server = serve([
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "wait", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ])
    const entered = Promise.withResolvers<AbortSignal>()
    const toolAborted = Promise.withResolvers<void>()
    const wait = tool<Record<string, never>, string>({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async (_, context) => {
        const signal = context.abortSignal
        if (!signal) throw new Error("Expected an abort signal")
        entered.resolve(signal)
        return new Promise<string>((_, reject) => {
          const onAbort = () => {
            toolAborted.resolve()
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          }
          if (signal.aborted) return onAbort()
          signal.addEventListener("abort", onAbort, { once: true })
        })
      },
    })
    const processTools = LLMAIProcess.prepareTools({ wait })
    if (!processTools) throw new Error("Expected tool to be safe for the AI process")
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const abort = new AbortController()
    const run = Effect.runPromise(
      LLMAIProcess.stream(input(server, processTools), { wait }, messages, abort.signal).pipe(
        Stream.takeUntil((event) => event.type === "tool-call"),
        Stream.runCollect,
      ),
    )

    const signal = await entered.promise
    const events = await run
    await toolAborted.promise
    expect(events.some((event) => event.type === "tool-call")).toBeTrue()
    expect(signal.aborted).toBeTrue()
    expect(abort.signal.aborted).toBeFalse()
  })

  test("falls back when tool callbacks cannot cross the process boundary", () => {
    const unsafe = tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => "ok",
      onInputStart() {},
    })
    expect(LLMAIProcess.prepareTools({ unsafe })).toBeUndefined()
  })

  test("falls back when tool schema validators cannot cross the process boundary", () => {
    const validating = jsonSchema(
      { type: "object", properties: {} },
      { validate: (value) => ({ success: true as const, value }) },
    )
    const inputValidator = tool<unknown, unknown>({
      inputSchema: validating,
      execute: async () => "ok",
    })
    const outputValidator = tool<unknown, unknown>({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      outputSchema: validating,
      execute: async () => "ok",
    })
    expect(LLMAIProcess.prepareTools({ inputValidator })).toBeUndefined()
    expect(LLMAIProcess.prepareTools({ outputValidator })).toBeUndefined()
  })

  test("normalizes provider options and falls back when they cannot cross the process boundary", () => {
    const model = ProviderTest.model({
      id: ModelV2.ID.make("compatible"),
      providerID: ProviderV2.ID.make("compatible"),
      api: { id: "compatible", url: "https://example.test/v1", npm: "@ai-sdk/openai-compatible" },
    })
    const options = LLMAIProcess.providerOptions(model, ProviderTest.info({ options: { baseURL: "" } }, model))
    expect(options).not.toBeFalse()
    if (!options) throw new Error("Expected compatible provider options")
    expect(options.baseURL).toBe(model.api.url)
    expect(options.includeUsage).toBeTrue()

    const withoutUsage = LLMAIProcess.providerOptions(
      model,
      ProviderTest.info({ options: { includeUsage: false } }, model),
    )
    expect(withoutUsage).not.toBeFalse()
    if (!withoutUsage) throw new Error("Expected compatible provider options")
    expect(withoutUsage.includeUsage).toBeFalse()

    expect(
      LLMAIProcess.providerOptions(
        { ...model, api: { ...model.api, url: "https://example.test/${ACCOUNT_ID}/v1" } },
        ProviderTest.info({}, model),
      ),
    ).toBeFalse()
    expect(
      LLMAIProcess.providerOptions(model, ProviderTest.info({ options: { fetch: async () => new Response() } }, model)),
    ).toBeFalse()
    expect(
      LLMAIProcess.providerOptions(
        { ...model, headers: { unsafe: (() => undefined) as unknown as string } },
        ProviderTest.info({}, model),
      ),
    ).toBeFalse()
  })

  test("falls back when transform inputs cannot cross the process boundary", () => {
    const model = ProviderTest.model()
    expect(LLMAIProcess.inputSupported(model, {})).toBeTrue()
    expect(LLMAIProcess.inputSupported({ ...model, options: { unsafe() {} } }, {})).toBeFalse()
    expect(LLMAIProcess.inputSupported(model, { unsafe() {} })).toBeFalse()
    expect(LLMAIProcess.inputSupported(model, {}, new URL("https://example.test/image.png"))).toBeFalse()
    expect(LLMAIProcess.inputSupported(model, {}, new ArrayBuffer(1))).toBeFalse()
    expect(LLMAIProcess.inputSupported(model, {}, Uint8Array.of(1))).toBeTrue()
    expect(LLMAIProcess.inputSupported(model, {}, Buffer.from([1]))).toBeTrue()
  })

  test("matches the normal request body after consecutive tool messages are combined", async () => {
    const bodies: string[] = []
    const server = serve([chunk({ role: "assistant" }), chunk({}, "stop"), "[DONE]"], 0, async (request) => {
      bodies.push(await request.text())
    })
    const model = ProviderTest.model({
      id: ModelV2.ID.make("claude-compatible"),
      providerID: ProviderV2.ID.make("test"),
      api: { id: "claude-compatible", url: `${server.url}v1`, npm: "@ai-sdk/openai-compatible" },
    })
    const messages: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: 1 } },
          { type: "tool-call", toolCallId: "call-2", toolName: "echo", input: { value: 2 } },
          { type: "tool-call", toolCallId: "call-3", toolName: "echo", input: { value: 3 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "echo",
            output: { type: "text", value: "result-1" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "echo",
            output: { type: "text", value: "result-2" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "echo",
            output: { type: "text", value: "result-3" },
          },
        ],
      },
    ]
    const options = { baseURL: `${server.url}v1`, apiKey: "test", includeUsage: true }
    const normal = streamText({
      model: wrapLanguageModel({
        model: createOpenAICompatible({ name: "test", ...options })(model.api.id),
        middleware: [LLMMessageTransform.middleware(model, {})],
      }),
      messages,
      maxRetries: 0,
    })
    for await (const _ of normal.fullStream) void _

    await Effect.runPromise(
      LLMAIProcess.stream(
        {
          ...input(server),
          model: model.api.id,
          modelInfo: model,
          options,
          messages,
        },
        {},
        messages,
        new AbortController().signal,
      ).pipe(Stream.runDrain),
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })

  test("uses the Responses API for OpenAI models below GPT-5", async () => {
    let pathname = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        pathname = new URL(request.url).pathname
        return Response.json({ error: { message: "stop after observing request" } }, { status: 400 })
      },
    })
    servers.push(server)
    const model = ProviderTest.model({
      id: ModelV2.ID.make("gpt-4.1"),
      providerID: ProviderV2.ID.openai,
      api: { id: "gpt-4.1", url: `${server.url}v1`, npm: "@ai-sdk/openai" },
    })
    await Effect.runPromise(
      LLMAIProcess.stream(
        {
          ...input(server),
          provider: "openai",
          package: "@ai-sdk/openai",
          model: "gpt-4.1",
          modelInfo: model,
        },
        {},
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ).pipe(Stream.runDrain),
    ).catch(() => undefined)
    expect(pathname).toBe("/v1/responses")
  })

  test("round-trips binary message content", () => {
    const value = {
      data: Uint8Array.from([0, 1, 127, 255]),
      buffer: Buffer.from([255, 127, 1, 0]),
      emptyKey: { "": Buffer.from([3, 2, 1]) },
      error: new Error("broken"),
    }
    const result = LLMWorkerIPC.parse(LLMWorkerIPC.stringify(value)) as typeof value
    expect(result.data).toEqual(value.data)
    expect([...result.buffer]).toEqual([...value.buffer])
    expect([...result.emptyKey[""]]).toEqual([...value.emptyKey[""]])
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toBe("broken")
  })

  test("reads large fragmented Unicode frames and the final frame at EOF", async () => {
    const text = "🙂漢字e\u0301".repeat(650_000)
    const first = { type: "events", events: [{ type: "text-delta", id: "large", text }] }
    const second = { type: "events", events: [{ type: "text-delta", id: "tail", text: "終🙂" }] }
    const bytes = new TextEncoder().encode(
      `${LLMWorkerIPC.stringify(first)}\n${LLMWorkerIPC.stringify({ type: "end" })}\n${LLMWorkerIPC.stringify(second)}`,
    )
    const sizes = [1, 2, 3, 5, 8_191]
    let offset = 0
    let index = 0
    const lines = LLMWorkerIPC.lineReader(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const end = Math.min(offset + sizes[index++ % sizes.length], bytes.length)
          controller.enqueue(bytes.subarray(offset, end))
          offset = end
          if (offset === bytes.length) controller.close()
        },
      }),
    )

    const firstLine = await lines.read()
    const endLine = await lines.read()
    const secondLine = await lines.read()
    if (firstLine === undefined || endLine === undefined || secondLine === undefined) {
      throw new Error("Expected all IPC frames")
    }
    const firstResult = LLMWorkerIPC.parse(firstLine) as typeof first
    expect(firstResult.events[0].text).toBe(text)
    expect(LLMWorkerIPC.parse(endLine)).toEqual({ type: "end" })
    expect(LLMWorkerIPC.parse(secondLine)).toEqual(second)
    expect(await lines.read()).toBeUndefined()
  }, 5_000)

  test("force-kills a TERM-resistant worker when the stream closes", async () => {
    if (process.platform === "win32") return
    const server = serve([])
    let pid = 0
    let rescued = false
    let rescue: ReturnType<typeof setTimeout> | undefined
    try {
      await Effect.runPromise(
        LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], new AbortController().signal, {
          command: fixtureCommand("ignore-term"),
          killGraceMs: 25,
        }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "text-delta") return
              pid = Number(event.text)
              fixtureProcesses.add(pid)
              rescue = setTimeout(() => {
                if (!running(pid)) return
                rescued = true
                process.kill(pid, "SIGKILL")
              }, 8_000)
            }),
          ),
          Stream.take(1),
          Stream.runDrain,
        ),
      )
    } finally {
      if (rescue) clearTimeout(rescue)
    }
    expect(pid).toBeGreaterThan(0)
    expect(rescued).toBeFalse()
    expect(running(pid)).toBeFalse()
    fixtureProcesses.delete(pid)
  }, 10_000)

  test("exits when stdin ends with an event acknowledgement and a later delta queued", async () => {
    const sendB = Promise.withResolvers<void>()
    const sendC = Promise.withResolvers<void>()
    const providerDone = Promise.withResolvers<void>()
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              const write = (value: unknown) =>
                controller.enqueue(encoder.encode(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`))
              write(chunk({ role: "assistant" }))
              write(chunk({ content: "A" }))
              await sendB.promise
              write(chunk({ content: "B" }))
              await sendC.promise
              write(chunk({ content: "C" }))
              write(chunk({}, "stop"))
              write("[DONE]")
              controller.close()
              providerDone.resolve()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)
    const child = Bun.spawn([process.execPath, runtimeWorker], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      lazy: true,
    })
    fixtureProcesses.add(child.pid)
    const stderr = new Response(child.stderr).text()
    const stdout = LLMWorkerIPC.lineReader(child.stdout)
    const stdin = LLMWorkerIPC.writer(child.stdin)
    let rescued = false
    let rescue: ReturnType<typeof setTimeout> | undefined
    try {
      await stdin.write({ type: "run", run: 1, input: input(server) })
      while (true) {
        const line = await stdout.read()
        if (line === undefined) throw new Error(`Worker exited before the gated delta: ${await stderr}`)
        const message = LLMWorkerIPC.parse(line) as {
          type: string
          run?: number
          id?: number
          events?: Array<{ type?: string; text?: string }>
        }
        if (message.type !== "events" || message.id === undefined || !message.events) continue
        const deltas = message.events.filter((event) => event.type === "text-delta").map((event) => event.text)
        if (deltas.includes("B")) {
          sendC.resolve()
          break
        }
        await stdin.write({ type: "events-ack", run: message.run, id: message.id })
        if (deltas.includes("A")) sendB.resolve()
      }

      rescue = setTimeout(() => {
        if (!running(child.pid)) return
        rescued = true
        child.kill("SIGKILL")
      }, 3_000)
      await providerDone.promise
      // C is queued behind the deliberately unacknowledged B frame.
      await Bun.sleep(350)
      await stdin.end()
      await child.exited
    } finally {
      sendB.resolve()
      sendC.resolve()
      if (rescue) clearTimeout(rescue)
      await stdout.cancel().catch(() => undefined)
      if (running(child.pid)) child.kill("SIGKILL")
    }
    expect(rescued).toBeFalse()
    expect(running(child.pid)).toBeFalse()
    fixtureProcesses.delete(child.pid)
  }, 10_000)

  test("force-kills a TERM-resistant worker when the caller aborts", async () => {
    if (process.platform === "win32") return
    const server = serve([])
    const abort = new AbortController()
    let pid = 0
    let rescued = false
    let rescue: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(
        Effect.runPromise(
          LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal, {
            command: fixtureCommand("ignore-term"),
            killGraceMs: 25,
          }).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type !== "text-delta") return
                pid = Number(event.text)
                fixtureProcesses.add(pid)
                rescue = setTimeout(() => {
                  if (!running(pid)) return
                  rescued = true
                  process.kill(pid, "SIGKILL")
                }, 8_000)
                abort.abort()
              }),
            ),
            Stream.runDrain,
          ),
        ),
      ).rejects.toThrow("Aborted")
    } finally {
      if (rescue) clearTimeout(rescue)
    }
    expect(pid).toBeGreaterThan(0)
    expect(rescued).toBeFalse()
    expect(running(pid)).toBeFalse()
    fixtureProcesses.delete(pid)
  }, 10_000)

  test("terminates the child when aborted", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    servers.push(server)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 100)
    await expect(
      Effect.runPromise(
        LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], abort.signal).pipe(
          Stream.runDrain,
        ),
      ),
    ).rejects.toThrow("Aborted")
  })
})
