import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { jsonSchema, streamText, tool } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AIProcessInput } from "./ai-process-client"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"

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
const model = (() => {
  if (input.package === "@ai-sdk/openai") {
    const provider = createOpenAI(input.options)
    return input.endpoint === "responses" ||
      (!input.endpoint && /^gpt-[5-9]/.test(input.model) && !input.model.startsWith("gpt-5-mini"))
      ? provider.responses(input.model)
      : provider.chat(input.model)
  }
  if (input.package === "@ai-sdk/anthropic") return createAnthropic(input.options)(input.model)
  return createOpenAICompatible({
    name: input.provider,
    ...input.options,
    baseURL: String(input.options.baseURL),
  })(input.model)
})()
const tools = Object.fromEntries(
  Object.entries(input.tools).map(([name, item]) => [
    name,
    tool({
      description: item.description,
      inputSchema: jsonSchema(item.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: (value, context) =>
        new Promise((resolve, reject) => {
          const id = requestID++
          pending.set(id, { resolve, reject })
          write({ type: "tool", id, name, input: value, callID: context.toolCallId })
        }),
    }),
  ]),
)
const result = streamText({
  model,
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
