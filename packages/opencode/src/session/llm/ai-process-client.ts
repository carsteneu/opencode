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
  readonly options: Record<string, unknown>
  readonly modelInfo: Provider.Model
  readonly messageTransformOptions: Record<string, unknown>
  readonly messages: ModelMessage[]
  readonly tools: Record<string, AIProcessTool>
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

export type AIProcessTool = {
  readonly type?: "function" | "dynamic"
  readonly description?: string
  readonly title?: string
  readonly providerOptions?: Tool["providerOptions"]
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly inputExamples?: Array<{ input: unknown }>
  readonly needsApproval?: boolean
  readonly strict?: boolean
  readonly toModelOutput: boolean
}

type ProcessEvent =
  | { readonly type: "events"; readonly events: unknown[] }
  | {
      readonly type: "tool"
      readonly action: "execute"
      readonly id: number
      readonly name: string
      readonly input: unknown
      readonly callID: string
    }
  | {
      readonly type: "tool"
      readonly action: "model-output"
      readonly id: number
      readonly name: string
      readonly input: unknown
      readonly output: unknown
      readonly callID: string
    }
  | { readonly type: "end" }
  | { readonly type: "error"; readonly error: string }

function command() {
  if (typeof OPENCODE_LLM_PROCESS !== "undefined" && OPENCODE_LLM_PROCESS)
    return [process.execPath, "__opencode_ai_worker__"]
  return [process.execPath, new URL("./ai-process-worker.ts", import.meta.url).pathname]
}

export function enabled() {
  return process.env.NODE_ENV !== "test" && process.env.OPENCODE_DISABLE_LLM_PROCESS !== "1"
}

export function providerOptions(model: Provider.Model, provider: Provider.Info) {
  if (!["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"].includes(model.api.npm)) return false
  if (model.api.npm === "@ai-sdk/openai" && model.providerID !== "openai") return false
  if (model.api.npm === "@ai-sdk/anthropic" && model.providerID !== "anthropic") return false
  if (!serializable(provider.options)) return false
  const baseURL =
    typeof provider.options.baseURL === "string" && provider.options.baseURL !== ""
      ? provider.options.baseURL
      : model.api.url || undefined
  if (baseURL?.match(/\$\{[^}]+\}/)) return false
  if (model.api.npm === "@ai-sdk/openai-compatible" && !baseURL) return false
  const options = {
    ...provider.options,
    ...(model.api.npm === "@ai-sdk/openai-compatible"
      ? { includeUsage: provider.options.includeUsage !== false }
      : {}),
    apiKey: provider.options.apiKey === undefined ? provider.key : provider.options.apiKey,
    baseURL,
    headers: { ...provider.options.headers, ...model.headers },
  }
  return serializable(options) ? options : false
}

function serializable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
    return false
  if (value instanceof Uint8Array) return true
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.every((item) => item !== undefined && serializable(item, seen))
    seen.delete(value)
    return result
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const result = Object.values(value).every((item) => serializable(item, seen))
  seen.delete(value)
  return result
}

export function inputSupported(...values: unknown[]) {
  return values.every((value) => serializable(value))
}

export function prepareTools(tools: Record<string, Tool>) {
  const entries = Object.entries(tools).map(([name, item]) => {
    if (!item.execute || item.type === "provider") return
    if (typeof item.needsApproval === "function") return
    if (item.onInputStart || item.onInputDelta || item.onInputAvailable) return
    const inputSchema = asSchema(item.inputSchema)
    const outputSchema = item.outputSchema ? asSchema(item.outputSchema) : undefined
    if (inputSchema.validate || outputSchema?.validate) return
    const value: AIProcessTool = {
      type: item.type,
      description: item.description,
      title: item.title,
      providerOptions: item.providerOptions,
      inputSchema: inputSchema.jsonSchema,
      outputSchema: outputSchema?.jsonSchema,
      inputExamples: item.inputExamples,
      needsApproval: item.needsApproval,
      strict: item.strict,
      toModelOutput: item.toModelOutput !== undefined,
    }
    if (!serializable(value)) return
    return [name, value] as const
  })
  if (entries.some((entry) => entry === undefined)) return
  return Object.fromEntries(entries.filter((entry) => entry !== undefined))
}

export function stream(input: AIProcessInput, tools: Record<string, Tool>, messages: ModelMessage[], abort: AbortSignal) {
  return Stream.callback<AISDKEvent, Error>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = Bun.spawn(command(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env })
        const lifecycle = new AbortController()
        const toolSignal = AbortSignal.any([abort, lifecycle.signal])
        let terminal = false
        let closed = false
        let killed = false
        const close = () => {
          if (!closed) {
            closed = true
            lifecycle.abort()
          }
          if (killed) return
          killed = true
          child.kill()
        }
        const write = (value: unknown) => {
          if (closed) return false
          void child.stdin.write(LLMWorkerIPC.stringify(value) + "\n")
          return true
        }
        const fail = (error: unknown) => {
          if (terminal) return
          terminal = true
          close()
          Queue.failCauseUnsafe(queue, Cause.fail(error instanceof Error ? error : new Error(String(error))))
        }
        const onAbort = () => {
          fail(new DOMException("Aborted", "AbortError"))
        }
        abort.addEventListener("abort", onAbort, { once: true })
        if (abort.aborted) onAbort()
        if (!terminal) {
          try {
            write(input)
          } catch (error) {
            fail(error)
          }
        }
        const executeTool = async (message: Extract<ProcessEvent, { type: "tool" }>) => {
          const tool = tools[message.name]
          const response = await (async () => {
            try {
              if (message.action === "model-output") {
                if (!tool?.toModelOutput) throw new Error(`Tool has no model output handler: ${message.name}`)
                return {
                  type: "tool-result",
                  id: message.id,
                  result: await tool.toModelOutput({
                    toolCallId: message.callID,
                    input: message.input,
                    output: message.output,
                  }),
                }
              }
              if (!tool?.execute) throw new Error(`Tool has no execute handler: ${message.name}`)
              return {
                type: "tool-result",
                id: message.id,
                result: await tool.execute(message.input, {
                  toolCallId: message.callID,
                  messages,
                  abortSignal: toolSignal,
                }),
              }
            } catch (error) {
              return {
                type: "tool-error",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          })()
          write(response)
        }
        const startTool = (message: Extract<ProcessEvent, { type: "tool" }>) => {
          void executeTool(message).catch(fail)
        }
        void read(child.stdout, (message) => {
          if (terminal) return
          if (message.type === "events") {
            Queue.offerAllUnsafe(queue, message.events as AISDKEvent[])
            return
          }
          if (message.type === "tool") {
            startTool(message)
            return
          }
          if (message.type === "end") {
            terminal = true
            closed = true
            lifecycle.abort()
            Queue.endUnsafe(queue)
            void child.stdin.end()
            return
          }
          fail(new Error(message.error))
        })
          .then(async () => {
            if (terminal) return
            const error = await new Response(child.stderr).text()
            fail(new Error(error.trim() || `LLM process exited with code ${await child.exited}`))
          })
          .catch(fail)
        const release = async () => {
          terminal = true
          close()
          await child.exited
        }
        return { onAbort, release }
      }),
      ({ onAbort, release }) =>
        Effect.promise(async () => {
          abort.removeEventListener("abort", onAbort)
          await release()
        }),
    ),
  )
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

export const LLMAIProcess = { enabled, providerOptions, inputSupported, stream, prepareTools }
