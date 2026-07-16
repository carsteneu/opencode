import { Cause, Effect, Queue, Stream } from "effect"
import type { ModelMessage, Tool } from "ai"
import type { Provider } from "@/provider/provider"
import { asSchema } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AISDKEvent } from "./ai-sdk"

declare global {
  const OPENCODE_LLM_PROCESS: boolean
}

export type AIProcessInput = {
  readonly provider: string
  readonly package: string
  readonly model: string
  readonly endpoint?: string
  readonly options: Record<string, unknown>
  readonly messages: ModelMessage[]
  readonly tools: Record<string, { description: string; inputSchema: unknown }>
  readonly activeTools: string[]
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, unknown>
  readonly headers: Record<string, string>
  readonly maxRetries: number
}

type ProcessEvent =
  | { readonly type: "events"; readonly events: unknown[] }
  | { readonly type: "tool"; readonly id: number; readonly name: string; readonly input: unknown; readonly callID: string }
  | { readonly type: "end" }
  | { readonly type: "error"; readonly error: string }

function command() {
  if (typeof OPENCODE_LLM_PROCESS !== "undefined" && OPENCODE_LLM_PROCESS)
    return [process.execPath, "__opencode_ai_worker__"]
  return [process.execPath, new URL("./ai-process-worker.ts", import.meta.url).pathname]
}

export function supported(model: Provider.Model, provider: Provider.Info) {
  if (process.env.NODE_ENV === "test") return false
  if (process.env.OPENCODE_DISABLE_LLM_PROCESS === "1") return false
  if (!["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"].includes(model.api.npm)) return false
  if (model.api.npm === "@ai-sdk/openai" && model.providerID !== "openai") return false
  if (model.api.npm === "@ai-sdk/anthropic" && model.providerID !== "anthropic") return false
  if (model.api.npm === "@ai-sdk/openai-compatible" && !provider.options.baseURL && !model.api.url) return false
  if (!serializable(provider.options)) return false
  return true
}

function serializable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true
  if (typeof value !== "object" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
    return false
  if (value instanceof Uint8Array) return true
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).every((item) => serializable(item, seen))
}

export function stream(input: AIProcessInput, tools: Record<string, Tool>, messages: ModelMessage[], abort: AbortSignal) {
  return Stream.callback<AISDKEvent, Error>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = Bun.spawn(command(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env })
        const write = (value: unknown) => child.stdin.write(LLMWorkerIPC.stringify(value) + "\n")
        const onAbort = () => {
          child.kill()
          Queue.failCauseUnsafe(queue, Cause.fail(new DOMException("Aborted", "AbortError")))
        }
        abort.addEventListener("abort", onAbort, { once: true })
        write(input)
        let terminal = false
        void read(child.stdout, async (message) => {
          if (message.type === "events") {
            Queue.offerAllUnsafe(queue, message.events as AISDKEvent[])
            return
          }
          if (message.type === "tool") {
            const tool = tools[message.name]
            try {
              if (!tool?.execute) throw new Error(`Tool has no execute handler: ${message.name}`)
              const result = await tool.execute(message.input, {
                toolCallId: message.callID,
                messages,
                abortSignal: abort,
              })
              write({ type: "tool-result", id: message.id, result })
            } catch (error) {
              write({ type: "tool-error", id: message.id, error: error instanceof Error ? error.message : String(error) })
            }
            return
          }
          if (message.type === "end") {
            terminal = true
            Queue.endUnsafe(queue)
            child.stdin.end()
            return
          }
          terminal = true
          Queue.failCauseUnsafe(queue, Cause.fail(new Error(message.error)))
        })
          .then(async () => {
            if (terminal || abort.aborted) return
            const error = await new Response(child.stderr).text()
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new Error(error.trim() || `LLM process exited with code ${await child.exited}`)),
            )
          })
          .catch((error) => Queue.failCauseUnsafe(queue, Cause.fail(error)))
        return { child, onAbort }
      }),
      ({ child, onAbort }) =>
        Effect.promise(async () => {
          abort.removeEventListener("abort", onAbort)
          child.kill()
          await child.exited
        }),
    ),
  )
}

export function inputSchema(tool: Tool) {
  return asSchema(tool.inputSchema).jsonSchema
}

async function read(stdout: ReadableStream<Uint8Array>, emit: (message: ProcessEvent) => void | Promise<void>) {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const result = await reader.read()
    if (result.done) break
    buffer += decoder.decode(result.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines.filter(Boolean)) await emit(LLMWorkerIPC.parse(line) as ProcessEvent)
  }
}

export const LLMAIProcess = { supported, stream, inputSchema }
