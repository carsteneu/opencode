import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"
import { asSchema, jsonSchema, simulateReadableStream, streamText, tool, type Tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { blockedTools } from "@/session/llm/blocked-tools"

const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
} satisfies LanguageModelV3StreamPart

async function drain(model: MockLanguageModelV3, tools: Record<string, Tool>) {
  const result = streamText({
    model,
    messages: [{ role: "user", content: "test" }],
    tools,
  })
  const events = []
  for await (const event of result.fullStream) events.push(event)
  return events
}

describe("blockedTools", () => {
  test("preserves definition order and provider serialization without mutating the originals", async () => {
    const first = tool<{ value: string }, { result: string }>({
      description: "First function",
      title: "First",
      providerOptions: { test: { cacheKey: "stable" } },
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
      outputSchema: jsonSchema({ type: "object", properties: { result: { type: "string" } } }),
      inputExamples: [{ input: { value: "example" } }],
      strict: true,
      execute: async ({ value }) => ({ result: value }),
      onInputStart() {},
      onInputDelta() {},
      onInputAvailable() {},
      needsApproval: async () => false,
      toModelOutput: ({ output }) => ({ type: "text", value: output.result }),
    })
    const dynamic = tool<Record<string, never>, { ok: boolean }>({
      type: "dynamic",
      description: "Dynamic function",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ ok: true }),
    })
    const remote = tool<{ query?: string }, { answer: string }>({
      type: "provider",
      id: "test.remote",
      args: { mode: "fast", nested: { enabled: true } },
      supportsDeferredResults: true,
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      execute: async () => ({ answer: "remote" }),
    })
    const tools = { first, dynamic, remote } satisfies Record<string, Tool>
    const blocked = await blockedTools(tools)

    expect(Object.keys(blocked)).toEqual(Object.keys(tools))
    expect(blocked).not.toBe(tools)
    expect(blocked.first).not.toBe(first)
    expect(first.execute).not.toBe(blocked.first?.execute)
    expect(first.onInputStart).toBeDefined()
    expect(first.onInputDelta).toBeDefined()
    expect(first.onInputAvailable).toBeDefined()
    expect(first.needsApproval).toBeDefined()
    expect(first.toModelOutput).toBeDefined()
    expect(blocked.remote).toMatchObject({
      type: "provider",
      id: "test.remote",
      args: { mode: "fast", nested: { enabled: true } },
      supportsDeferredResults: true,
    })

    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks: [{ type: "stream-start", warnings: [] }, finish],
        }),
      }),
    })
    await drain(model, tools)
    await drain(model, blocked)

    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[1]?.tools)).toBe(JSON.stringify(model.doStreamCalls[0]?.tools))
  })

  test("blocks every original runtime hook before the AI SDK can dispatch it", async () => {
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
    const guarded = tool<{ value: string }, { result: string }>({
      description: "Guarded function",
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
        { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
        {
          validate: (value) => {
            sideEffects.outputValidate++
            return { success: true, value: value as { result: string } }
          },
        },
      ),
      execute: async ({ value }) => {
        sideEffects.execute++
        return { result: value }
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
        return { type: "text", value: output.result }
      },
    })
    const blocked = await blockedTools({ guarded })
    const blockedGuarded = blocked.guarded

    expect(blockedGuarded).toBeDefined()
    expect(blockedGuarded?.execute).not.toBe(guarded.execute)
    expect(blockedGuarded?.onInputStart).toBeUndefined()
    expect(blockedGuarded?.onInputDelta).toBeUndefined()
    expect(blockedGuarded?.onInputAvailable).toBeUndefined()
    expect(blockedGuarded?.needsApproval).toBeUndefined()
    expect(blockedGuarded?.toModelOutput).toBeUndefined()
    expect(asSchema(blockedGuarded?.inputSchema).validate).toBeUndefined()
    expect(asSchema(blockedGuarded?.outputSchema).validate).toBeUndefined()

    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-local", toolName: "guarded" },
      { type: "tool-input-delta", id: "call-local", delta: '{"value":"local"}' },
      { type: "tool-input-end", id: "call-local" },
      {
        type: "tool-call",
        toolCallId: "call-local",
        toolName: "guarded",
        input: '{"value":"local"}',
      },
      { type: "tool-input-start", id: "call-provider", toolName: "guarded", providerExecuted: true },
      { type: "tool-input-delta", id: "call-provider", delta: '{"value":"provider"}' },
      { type: "tool-input-end", id: "call-provider" },
      {
        type: "tool-call",
        toolCallId: "call-provider",
        toolName: "guarded",
        input: '{"value":"provider"}',
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "call-provider",
        toolName: "guarded",
        result: { result: "provider" },
      },
      { ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
    ] satisfies LanguageModelV3StreamPart[]
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
    })
    const events = await drain(model, blocked)

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
    expect(events.some((event) => event.type === "tool-error")).toBeTrue()
    expect(guarded.onInputStart).toBeDefined()
    expect(asSchema(guarded.inputSchema).validate).toBeDefined()
    expect(asSchema(guarded.outputSchema).validate).toBeDefined()
  })
})
