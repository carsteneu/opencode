import { afterEach, describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Stream } from "effect"
import { LLMAIProcess, type AIProcessInput } from "@/session/llm/ai-process-client"
import { LLMWorkerIPC } from "@/session/llm/ipc"

const servers: Bun.Server<unknown>[] = []

afterEach(() => servers.splice(0).map((server) => server.stop(true)))

function input(server: Bun.Server<unknown>, tools: AIProcessInput["tools"] = {}): AIProcessInput {
  return {
    provider: "test",
    package: "@ai-sdk/openai-compatible",
    model: "test-model",
    options: { baseURL: `${server.url}v1`, apiKey: "test" },
    messages: [{ role: "user", content: "hello" }],
    tools,
    activeTools: Object.keys(tools),
    headers: {},
    maxRetries: 0,
  }
}

function serve(lines: unknown[], delay = 0) {
  const server = Bun.serve({
    port: 0,
    async fetch() {
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
    const server = serve([
      chunk({ role: "assistant" }),
      chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"value":"ok"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ])
    let called = false
    const echo = tool({
      inputSchema: jsonSchema<{ value: string }>({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      }),
      execute: async (value) => {
        called = true
        return value.value
      },
    })
    const events = await Effect.runPromise(
      LLMAIProcess.stream(
        input(server, { echo: { description: "echo", inputSchema: LLMAIProcess.inputSchema(echo) } }),
        { echo },
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ).pipe(Stream.runCollect),
    )
    expect(called).toBeTrue()
    expect(events.some((event) => event.type === "tool-result")).toBeTrue()
  })

  test("round-trips binary message content", () => {
    const value = { data: Uint8Array.from([0, 1, 127, 255]), error: new Error("broken") }
    const result = LLMWorkerIPC.parse(LLMWorkerIPC.stringify(value)) as typeof value
    expect(result.data).toEqual(value.data)
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
