import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const RESUME_CONTINUE_NOTICE =
  "The response above was interrupted by a transient provider or network error. " +
  "Continue from where it ends. Do not repeat content you already wrote. " +
  "If you announced a tool call that never completed, you may call it again."

export type ResumePart =
  | Pick<SessionV1.TextPart, "type" | "text" | "metadata">
  | Pick<SessionV1.ReasoningPart, "type" | "text" | "metadata">
  | Pick<SessionV1.ToolPart, "type" | "tool" | "callID" | "state">
  | { type: string }

type AssistantContentPart = ToolCallPart | { type: "text"; text: string } | { type: "reasoning"; text: string }

function toolResultOutput(part: SessionV1.ToolPart): ToolResultPart["output"] {
  if (part.state.status === "error") {
    const output = part.state.metadata?.output
    return typeof output === "string" ? { type: "text", value: output } : { type: "error-text", value: part.state.error }
  }
  return { type: "text", value: "output" in part.state ? part.state.output : "" }
}

// Builds the ModelMessage suffix for a resume attempt: a partial assistant
// message with the already committed content, results for executed tools, and
// a trailing user notice. Tool calls that were announced but never executed
// (pending/running) are rewound so the model may call them again.
export function buildResumeMessages(parts: ReadonlyArray<ResumePart>): ModelMessage[] {
  const content: AssistantContentPart[] = []
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
          output: toolResultOutput(part),
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
