import { jsonSchema, streamText, tool, type Tool, wrapLanguageModel } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AIProcessInput } from "./ai-process-client"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import { applyRuntimeFetch } from "@/provider/runtime-fetch"
import { LLMMessageTransform } from "./message-transform"
import { ProviderError } from "@/provider/error"

// @ts-ignore AI SDK uses this global flag to suppress provider warnings on stdout.
globalThis.AI_SDK_LOG_WARNINGS = false
const deltaFlushMs = 50

type ToolRequest =
  | { action: "execute"; name: string; input: unknown; callID: string }
  | { action: "model-output"; name: string; input: unknown; output: unknown; callID: string }
type ToolModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>
type Turn = {
  readonly run: number
  readonly abort: AbortController
  readonly pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  readonly acknowledgements: Map<number, { resolve: () => void; reject: (error: Error) => void }>
  phase: "running" | "ready"
}
type InputFrame =
  | { type: "run"; run: number; input: AIProcessInput }
  | { type: "tool-result"; run: number; id: number; result: unknown }
  | { type: "tool-error"; run: number; id: number; error: string }
  | { type: "events-ack"; run: number; id: number }

const lines = LLMWorkerIPC.lineReader(Bun.stdin.stream())
const output = LLMWorkerIPC.writer(Bun.stdout.writer())
let active: Turn | undefined
let queued: Extract<InputFrame, { type: "run" }> | undefined
let failed = false
let lastRun = -1

const reset = (turn: Turn, error?: Error) => {
  const reason = error ?? new DOMException("LLM process turn completed", "AbortError")
  turn.abort.abort(reason)
  turn.pending.forEach((item) => item.reject(reason))
  turn.acknowledgements.forEach((item) => item.reject(reason))
  turn.pending.clear()
  turn.acknowledgements.clear()
}

const fail = async (error: unknown, run = active?.run ?? -1) => {
  if (failed) return
  failed = true
  if (active) reset(active, error instanceof Error ? error : new Error(String(error)))
  active = undefined
  queued = undefined
  const detail = providerFailure(error)
  await output
    .write({
      type: "error",
      run,
      error: detail?.error ?? (error instanceof Error ? error.message : String(error)),
      kind: detail?.kind,
      timeoutMs: detail?.timeoutMs,
    })
    .catch(() => undefined)
  await output.end().catch(() => undefined)
  await lines.cancel().catch(() => undefined)
  process.exitCode = 1
}

const providerFailure = (error: unknown) => {
  let current = error
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof ProviderError.HeaderTimeoutError) {
      return { kind: "header-timeout" as const, error: current.message, timeoutMs: current.ms }
    }
    if (current instanceof ProviderError.ResponseStreamError) {
      return { kind: "response-stream" as const, error: current.message }
    }
    if (!(current instanceof Error) || current.cause === current) return undefined
    current = current.cause
  }
  return undefined
}

const execute = async (turn: Turn, input: AIProcessInput) => {
  try {
    await run(turn, input)
    if (turn.pending.size > 0 || turn.acknowledgements.size > 0)
      throw new Error("LLM process turn ended with outstanding IPC requests")
    await output.write({ type: "end", run: turn.run })
    reset(turn)
    if (active !== turn) throw new Error("LLM process turn ownership changed before reset")
    turn.phase = "ready"
    await output.write({ type: "ready", run: turn.run, rss: process.memoryUsage().rss })
    active = undefined
    const next = queued
    queued = undefined
    if (next) start(next)
  } catch (error) {
    await fail(error, turn.run)
  }
}

try {
  while (!failed) {
    const value = await lines.read()
    if (value === undefined) {
      if (active) await fail(new DOMException("LLM process input ended", "AbortError"), active.run)
      break
    }
    if (!value) continue
    const frame = LLMWorkerIPC.parse(value)
    if (!frame || typeof frame !== "object" || !("type" in frame) || !("run" in frame)) {
      await fail(new Error("Invalid LLM process frame"))
      break
    }
    const message = frame as InputFrame
    if (typeof message.type !== "string" || !Number.isSafeInteger(message.run) || message.run < 0) {
      await fail(new Error("Invalid LLM process frame"))
      break
    }
    if (message.type === "run") {
      if (!("input" in message) || !message.input || typeof message.input !== "object" || message.run <= lastRun) {
        await fail(new Error("Invalid or reused LLM process run"), message.run)
        break
      }
      if (active) {
        if (active.phase === "ready" && !queued) {
          queued = message
          continue
        }
        await fail(new Error("LLM process does not support concurrent turns"), message.run)
        break
      }
      start(message)
      continue
    }
    if (!Number.isSafeInteger(message.id) || message.id < 0) {
      await fail(new Error("Invalid LLM process response ID"), message.run)
      break
    }
    if (!active || message.run !== active.run) {
      await fail(new Error("LLM process frame belongs to a stale turn"), message.run)
      break
    }
    if (message.type === "events-ack") {
      const item = active.acknowledgements.get(message.id)
      if (!item) {
        await fail(new Error("Unexpected LLM process event acknowledgement"), message.run)
        break
      }
      active.acknowledgements.delete(message.id)
      item.resolve()
      continue
    }
    if (message.type !== "tool-result" && (message.type !== "tool-error" || typeof message.error !== "string")) {
      await fail(new Error("Unknown LLM process frame"), message.run)
      break
    }
    const item = active.pending.get(message.id)
    if (!item) {
      await fail(new Error("Unexpected LLM process tool result"), message.run)
      break
    }
    active.pending.delete(message.id)
    if (message.type === "tool-result") item.resolve(message.result)
    else item.reject(new Error(message.error))
  }
} catch (error) {
  await fail(error)
}

if (!failed) await output.end()

function start(message: Extract<InputFrame, { type: "run" }>) {
  const turn: Turn = {
    run: message.run,
    abort: new AbortController(),
    pending: new Map(),
    acknowledgements: new Map(),
    phase: "running",
  }
  lastRun = message.run
  active = turn
  void execute(turn, message.input)
}

async function run(turn: Turn, input: AIProcessInput) {
  let requestID = 0
  let eventID = 0
  let eventOutput = Promise.resolve()
  let eventOutputError: unknown
  const writeEvents = (events: unknown[]) => {
    const result = eventOutput.then(() => {
      if (eventOutputError) throw eventOutputError
      turn.abort.signal.throwIfAborted()
      return new Promise<void>((resolve, reject) => {
        const id = eventID++
        turn.acknowledgements.set(id, { resolve, reject })
        void output.write({ type: "events", run: turn.run, id, events }).catch((error) => {
          turn.acknowledgements.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      })
    })
    eventOutput = result.then(
      () => undefined,
      (error) => {
        eventOutputError = error
      },
    )
    return result
  }
  const options = applyRuntimeFetch({ ...input.options })
  const model = await (async () => {
    if (input.package === "@ai-sdk/openai") {
      const { createOpenAI } = await import("@ai-sdk/openai")
      return createOpenAI(options).responses(input.model)
    }
    if (input.package === "@ai-sdk/anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      return createAnthropic(options)(input.model)
    }
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
    return createOpenAICompatible({
      name: input.provider,
      ...options,
      baseURL: String(options.baseURL),
    })(input.model)
  })()
  const requestTool = (message: ToolRequest) =>
    new Promise<unknown>((resolve, reject) => {
      const id = requestID++
      turn.pending.set(id, { resolve, reject })
      void output.write({ type: "tool", run: turn.run, id, ...message }).catch((error) => {
        turn.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  const tools = Object.fromEntries(
    Object.entries(input.tools).map(([name, item]) => [
      name,
      tool<unknown, unknown>({
        type: item.type,
        description: item.description,
        title: item.title,
        providerOptions: item.providerOptions,
        inputSchema: jsonSchema(item.inputSchema as Parameters<typeof jsonSchema>[0]),
        outputSchema: item.outputSchema ? jsonSchema(item.outputSchema as Parameters<typeof jsonSchema>[0]) : undefined,
        inputExamples: item.inputExamples,
        needsApproval: item.needsApproval,
        strict: item.strict,
        execute: (value, context) => requestTool({ action: "execute", name, input: value, callID: context.toolCallId }),
        toModelOutput: item.toModelOutput
          ? async (options) =>
              (await requestTool({
                action: "model-output",
                name,
                input: options.input,
                output: options.output,
                callID: options.toolCallId,
              })) as ToolModelOutput
          : undefined,
      }),
    ]),
  )
  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: [LLMMessageTransform.middleware(input.modelInfo, input.messageTransformOptions)],
    }),
    abortSignal: turn.abort.signal,
    messages: input.messages,
    tools,
    activeTools: input.activeTools,
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: input.providerOptions as SharedV3ProviderOptions,
    headers: input.headers,
    maxRetries: input.maxRetries,
    async experimental_repairToolCall(failed) {
      const lower = failed.toolCall.toolName.toLowerCase()
      if (lower !== failed.toolCall.toolName && tools[lower]) return { ...failed.toolCall, toolName: lower }
      return {
        ...failed.toolCall,
        input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
        toolName: "invalid",
      }
    },
  })
  let pendingDelta: { event: unknown & { type: string; id?: string; text?: string } } | undefined
  let currentDelta: { type: string; id?: string } | undefined
  let timer: Timer | undefined
  const flush = async () => {
    if (!pendingDelta) return
    const event = pendingDelta.event
    pendingDelta = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
    await writeEvents([event])
  }
  try {
    for await (const event of result.fullStream) {
      if (event.type === "error" && providerFailure(event.error)) {
        await flush()
        throw event.error
      }
      if (event.type !== "text-delta" && event.type !== "reasoning-delta") {
        await flush()
        currentDelta = undefined
        await writeEvents([event])
        continue
      }
      if (currentDelta?.type !== event.type || currentDelta.id !== event.id) {
        await flush()
        currentDelta = { type: event.type, id: event.id }
        await writeEvents([event])
        continue
      }
      if (pendingDelta) {
        pendingDelta.event = { ...event, text: (pendingDelta.event.text ?? "") + event.text }
        continue
      }
      pendingDelta = { event }
      timer = setTimeout(() => {
        void flush().catch((error) => turn.abort.abort(error))
      }, deltaFlushMs)
    }
    await flush()
    await eventOutput
    if (eventOutputError) throw eventOutputError
  } finally {
    if (timer) clearTimeout(timer)
  }
}
