import type { AssistantContent, ModelMessage, ToolResultPart } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const RESUME_CONTINUE_NOTICE =
  "The response above was interrupted by a transient provider or network error. " +
  "Continue from where it ends. Do not repeat content you already wrote. " +
  "If you announced a tool call that never completed, you may call it again."

export type ResumePart =
  | { type: "text"; text: string; metadata?: Record<string, any> }
  | { type: "reasoning"; text: string; metadata?: Record<string, any> }
  | { type: "tool"; callID: string; tool: string; state: SessionV1.ToolState }
  | { type: "step-start"; snapshot?: string | undefined }
  | { type: "patch"; hash: string; files: string[] }
  | { type: "file"; mime: string; url: string }
  | { type: "step-finish"; reason: string }
  | { type: "snapshot"; snapshot: string }
  | { type: "agent"; name: string }
  | { type: "retry"; attempt: number }
  | { type: "compaction"; auto: boolean }
  | { type: "subtask"; prompt: string; description: string; agent: string }

type ContentPart = Exclude<AssistantContent, string>

function toolResultOutput(state: SessionV1.ToolState): ToolResultPart["output"] {
  if (state.status === "error") {
    const output = "metadata" in state ? state.metadata?.output : undefined
    return typeof output === "string" ? { type: "text", value: output } : { type: "error-text", value: state.error }
  }
  return { type: "text", value: "output" in state ? state.output : "" }
}

// Builds the ModelMessage suffix for a resume attempt: a partial assistant
// message with the already committed content, results for executed tools, and
// a trailing user notice. Tool calls that were announced but never executed
// (pending/running) are rewound so the model may call them again.
export function buildResumeMessages(parts: ReadonlyArray<ResumePart>): ModelMessage[] {
  const content: ContentPart = []
  const toolResults: ModelMessage[] = []
  let hasContent = false

  for (const part of parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      hasContent = true
      continue
    }
    if (part.type === "reasoning") {
      content.push({
        type: "reasoning",
        text: part.text,
        ...(part.metadata ? { providerOptions: part.metadata } : {}),
      })
      hasContent = true
      continue
    }
    if (part.type !== "tool") continue
    if (part.state.status === "pending" || part.state.status === "running") continue
    content.push({
      type: "tool-call",
      toolCallId: part.callID,
      toolName: part.tool,
      input: part.state.input,
    })
    toolResults.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: toolResultOutput(part.state),
        },
      ],
    })
    hasContent = true
  }

  const messages: ModelMessage[] = []
  if (hasContent) messages.push({ role: "assistant", content })
  messages.push(...toolResults)
  messages.push({ role: "user", content: RESUME_CONTINUE_NOTICE })
  return messages
}

export * as Resume from "./resume"
