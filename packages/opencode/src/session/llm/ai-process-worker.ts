import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { jsonSchema, streamText, tool, type Tool, wrapLanguageModel } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AIProcessInput } from "./ai-process-client"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import { applyRuntimeFetch } from "@/provider/runtime-fetch"
import { LLMMessageTransform } from "./message-transform"

// @ts-ignore AI SDK uses this global flag to suppress provider warnings on stdout.
globalThis.AI_SDK_LOG_WARNINGS = false

const lines = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let buffer = ""

async function line() {
  while (true) {
    const index = buffer.indexOf("\n")
    if (index !== -1) {
      const result = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      return result
    }
    const result = await lines.read()
    if (result.done) return buffer
    buffer += decoder.decode(result.value, { stream: true })
  }
}

const input = LLMWorkerIPC.parse(await line()) as AIProcessInput
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const abort = new AbortController()
let requestID = 0
void (async () => {
  while (true) {
    const value = await line()
    if (!value) {
      abort.abort()
      return
    }
    const message = LLMWorkerIPC.parse(value) as
      | { type: "tool-result"; id: number; result: unknown }
      | { type: "tool-error"; id: number; error: string }
    const item = pending.get(message.id)
    if (!item) continue
    pending.delete(message.id)
    if (message.type === "tool-result") item.resolve(message.result)
    else item.reject(new Error(message.error))
  }
})()

const write = (value: unknown) => process.stdout.write(LLMWorkerIPC.stringify(value) + "\n")
const options = applyRuntimeFetch({ ...input.options })
const model = (() => {
  if (input.package === "@ai-sdk/openai") {
    const provider = createOpenAI(options)
    return provider.responses(input.model)
  }
  if (input.package === "@ai-sdk/anthropic") return createAnthropic(options)(input.model)
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
    write({ type: "tool", id, ...message })
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
      outputSchema: item.outputSchema
        ? jsonSchema(item.outputSchema as Parameters<typeof jsonSchema>[0])
        : undefined,
      inputExamples: item.inputExamples,
      needsApproval: item.needsApproval,
      strict: item.strict,
      execute: (value, context) =>
        requestTool({ action: "execute", name, input: value, callID: context.toolCallId }),
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
let timer: Timer | undefined
const flush = () => {
  if (!pendingDelta) return
  write({ type: "events", events: [pendingDelta.event] })
  pendingDelta = undefined
  if (timer) clearTimeout(timer)
  timer = undefined
}
for await (const event of result.fullStream) {
  if (
    pendingDelta &&
    (event.type === "text-delta" || event.type === "reasoning-delta") &&
    pendingDelta.event.type === event.type &&
    pendingDelta.event.id === event.id
  ) {
    pendingDelta.event = { ...event, text: (pendingDelta.event.text ?? "") + event.text }
    continue
  }
  flush()
  if (event.type !== "text-delta" && event.type !== "reasoning-delta") {
    write({ type: "events", events: [event] })
    continue
  }
  pendingDelta = { event }
  timer = setTimeout(flush, 200)
}
flush()
write({ type: "end" })
