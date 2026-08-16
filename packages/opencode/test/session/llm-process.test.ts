import { afterEach, describe, expect, test } from "bun:test"
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

const servers: Bun.Server<unknown>[] = []

afterEach(() => servers.splice(0).map((server) => server.stop(true)))

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

function serve(lines: unknown[], delay = 0, inspect?: (request: Request) => void | Promise<void>) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await inspect?.(request)
      const body = new ReadableStream({
        async start(controller) {
          for (const value of lines) {
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
  test("streams through a child and coalesces text without changing content", async () => {
    const text = Array.from({ length: 80 }, (_, index) => String(index % 10))
    const server = serve(
      [chunk({ role: "assistant" }), ...text.map((value) => chunk({ content: value })), chunk({}, "stop"), "[DONE]"],
      4,
    )
    const events = await Effect.runPromise(
      LLMAIProcess.stream(input(server), {}, [{ role: "user", content: "hello" }], new AbortController().signal).pipe(
        Stream.runCollect,
      ),
    )
    const deltas = events.filter((event) => event.type === "text-delta")
    expect(deltas.map((event) => event.text).join("")).toBe(text.join(""))
    expect(deltas.length).toBeLessThan(20)
    expect(events.some((event) => event.type === "finish")).toBeTrue()
  })

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
    const options = LLMAIProcess.providerOptions(
      model,
      ProviderTest.info({ options: { baseURL: "" } }, model),
    )
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
      LLMAIProcess.providerOptions(
        model,
        ProviderTest.info({ options: { fetch: async () => new Response() } }, model),
      ),
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
    const server = serve(
      [chunk({ role: "assistant" }), chunk({}, "stop"), "[DONE]"],
      0,
      async (request) => {
        bodies.push(await request.text())
      },
    )
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
