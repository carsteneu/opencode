import { jsonSchema, streamText, tool, type Tool, wrapLanguageModel } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AIProcessInput } from "./ai-process-client"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import { applyRuntimeFetch } from "@/provider/runtime-fetch"
import { LLMMessageTransform } from "./message-transform"

// @ts-ignore AI SDK uses this global flag to suppress provider warnings on stdout.
globalThis.AI_SDK_LOG_WARNINGS = false
const deltaFlushMs = 50

const lines = LLMWorkerIPC.lineReader(Bun.stdin.stream())
const initial = await lines.read()
if (!initial) throw new Error("LLM process input ended before the request")
const input = LLMWorkerIPC.parse(initial) as AIProcessInput
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const acknowledgements = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
const abort = new AbortController()
let requestID = 0
let eventID = 0
void (async () => {
  while (true) {
    const value = await lines.read()
    if (value === undefined) {
      const error = new DOMException("LLM process input ended", "AbortError")
      abort.abort(error)
      pending.forEach((item) => item.reject(error))
      acknowledgements.forEach((item) => item.reject(error))
      pending.clear()
      acknowledgements.clear()
      return
    }
    if (!value) continue
    const message = LLMWorkerIPC.parse(value) as
      | { type: "tool-result"; id: number; result: unknown }
      | { type: "tool-error"; id: number; error: string }
      | { type: "events-ack"; id: number }
    if (message.type === "events-ack") {
      const item = acknowledgements.get(message.id)
      if (!item) continue
      acknowledgements.delete(message.id)
      item.resolve()
      continue
    }
    const item = pending.get(message.id)
    if (!item) continue
    pending.delete(message.id)
    if (message.type === "tool-result") item.resolve(message.result)
    else item.reject(new Error(message.error))
  }
})()

const output = LLMWorkerIPC.writer(Bun.stdout.writer())
const write = output.write
let eventOutput = Promise.resolve()
let eventOutputError: unknown
const writeEvents = (events: unknown[]) => {
  const result = eventOutput.then(() => {
    if (eventOutputError) throw eventOutputError
    abort.signal.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const id = eventID++
      acknowledgements.set(id, { resolve, reject })
      void write({ type: "events", id, events }).catch((error) => {
        acknowledgements.delete(id)
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
    const provider = createOpenAI(options)
    return provider.responses(input.model)
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
type ToolRequest =
  | { action: "execute"; name: string; input: unknown; callID: string }
  | { action: "model-output"; name: string; input: unknown; output: unknown; callID: string }
type ToolModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>
const requestTool = (message: ToolRequest) =>
  new Promise<unknown>((resolve, reject) => {
    const id = requestID++
    pending.set(id, { resolve, reject })
    void write({ type: "tool", id, ...message }).catch((error) => {
      pending.delete(id)
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
  abortSignal: abort.signal,
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
for await (const event of result.fullStream) {
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
    void flush().catch((error) => abort.abort(error))
  }, deltaFlushMs)
}
await flush()
await eventOutput
if (eventOutputError) throw eventOutputError
await write({ type: "end" })
await output.end()
