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
  | { readonly type: "events"; readonly id: number; readonly events: unknown[] }
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

export type ProcessOptions = {
  readonly command?: string[]
  readonly killGraceMs?: number
}

const stderrLimit = 64 * 1024
const killGraceMs = 1_000

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

export function stream(
  input: AIProcessInput,
  tools: Record<string, Tool>,
  messages: ModelMessage[],
  abort: AbortSignal,
  options?: ProcessOptions,
) {
  return Stream.callback<AISDKEvent, Error>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const child = Bun.spawn(options?.command ?? command(), {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
            lazy: true,
          })
          const stdout = LLMWorkerIPC.lineReader(child.stdout)
          const stderr = captureStderr(child.stderr)
          const grace = Math.max(0, options?.killGraceMs ?? killGraceMs)
          const inputWriter = LLMWorkerIPC.writer(child.stdin)
          let termination: Promise<void> | undefined
          let terminationError = ""
          const lifecycle = new AbortController()
          const toolSignal = AbortSignal.any([abort, lifecycle.signal])
          let terminal = false
          let closed = false
          const close = () => {
            if (!closed) {
              closed = true
              lifecycle.abort()
            }
            if (termination) return termination
            termination = (async () => {
              try {
                if (child.exitCode === null) child.kill("SIGTERM")
              } catch (error) {
                terminationError += `\nFailed to send SIGTERM: ${error instanceof Error ? error.message : String(error)}`
              }
              if (await settlesWithin(child.exited, grace)) return
              try {
                if (child.exitCode === null) child.kill("SIGKILL")
              } catch (error) {
                terminationError += `\nFailed to send SIGKILL: ${error instanceof Error ? error.message : String(error)}`
              }
              if (await settlesWithin(child.exited, grace)) return
              void stdout.cancel().catch(() => undefined)
              void stderr.cancel().catch(() => undefined)
              try {
                child.unref()
              } catch (error) {
                terminationError += `\nFailed to unref LLM process: ${error instanceof Error ? error.message : String(error)}`
              }
              terminationError += "\nLLM process did not exit after SIGKILL"
            })()
            return termination
          }
          const write = async (value: unknown) => {
            if (closed) return false
            await inputWriter.write(value)
            return true
          }
          const end = inputWriter.end
          const fail = (error: unknown) => {
            if (terminal) return
            terminal = true
            void close()
            Queue.failCauseUnsafe(queue, Cause.fail(error instanceof Error ? error : new Error(String(error))))
          }
          const onAbort = () => {
            fail(new DOMException("Aborted", "AbortError"))
          }
          abort.addEventListener("abort", onAbort, { once: true })
          if (abort.aborted) onAbort()
          if (!terminal) void write(input).catch(fail)
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
            await write(response)
          }
          const startTool = (message: Extract<ProcessEvent, { type: "tool" }>) => {
            void executeTool(message).catch(fail)
          }
          void read(stdout, async (message) => {
            if (terminal) return
            if (message.type === "events") {
              const remaining = await Effect.runPromise(Queue.offerAll(queue, message.events as AISDKEvent[]))
              if (remaining.length > 0) throw new DOMException("LLM event queue closed", "AbortError")
              if (terminal) return
              if (!(await write({ type: "events-ack", id: message.id })))
                throw new DOMException("LLM process input closed", "AbortError")
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
              void end().catch(() => undefined)
              return
            }
            fail(new Error(message.error))
          })
            .then(async () => {
              if (terminal) return
              await close()
              await settlesWithin(stderr.done, Math.max(grace, 100))
              fail(
                new Error(
                  (stderr.text() + terminationError).trim() ||
                    `LLM process exited with code ${child.exitCode ?? "unknown"}`,
                ),
              )
            })
            .catch(fail)
          const release = async () => {
            terminal = true
            await close()
            await settlesWithin(stderr.done, Math.max(grace, 100))
          }
          return { onAbort, release }
        }),
        ({ onAbort, release }) =>
          Effect.promise(async () => {
            abort.removeEventListener("abort", onAbort)
            await release()
          }),
      ),
    { bufferSize: 1, strategy: "suspend" },
  )
}

async function read(
  lines: ReturnType<typeof LLMWorkerIPC.lineReader>,
  emit: (message: ProcessEvent) => void | Promise<void>,
) {
  while (true) {
    const line = await lines.read()
    if (line === undefined) return
    if (line) await emit(LLMWorkerIPC.parse(line) as ProcessEvent)
  }
}

function captureStderr(stderr: ReadableStream<Uint8Array>) {
  const ring = new Uint8Array(stderrLimit)
  const reader = stderr.getReader()
  let size = 0
  let next = 0
  let readError = ""
  const done = (async () => {
    while (true) {
      const result = await reader.read()
      if (result.done) return
      const chunk = result.value
      if (chunk.length >= ring.length) {
        ring.set(chunk.subarray(chunk.length - ring.length))
        size = ring.length
        next = 0
        continue
      }
      const first = Math.min(chunk.length, ring.length - next)
      ring.set(chunk.subarray(0, first), next)
      if (first < chunk.length) ring.set(chunk.subarray(first), 0)
      next = (next + chunk.length) % ring.length
      size = Math.min(ring.length, size + chunk.length)
    }
  })().catch((error) => {
    readError = `\nFailed to read worker stderr: ${error instanceof Error ? error.message : String(error)}`
  })

  const text = () => {
    if (size < ring.length) return new TextDecoder().decode(ring.subarray(0, size)) + readError
    const value = new Uint8Array(size)
    value.set(ring.subarray(next))
    value.set(ring.subarray(0, next), ring.length - next)
    return new TextDecoder().decode(value) + readError
  }
  const cancel = () => reader.cancel()
  return { done, text, cancel }
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

export const LLMAIProcess = { enabled, providerOptions, inputSupported, stream, prepareTools }
