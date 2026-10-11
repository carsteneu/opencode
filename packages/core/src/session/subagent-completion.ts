export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import { ToolOutput } from "../tool-output.js"
import type { SessionMessage } from "./message.js"

export const NO_TEXT = "Subagent completed without a text response."

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

// v1 injected subagent results through Truncate.output with its default limits
// (packages/opencode/src/tool/task.ts:245; packages/opencode/src/tool/truncate.ts
// MAX_LINES 2000 / MAX_BYTES 50 KiB). The notification fiber is global rather
// than Location-scoped, so the full text is dropped instead of persisted.
export function bound(value: string) {
  const lines = value.split("\n")
  if (value.endsWith("\n")) lines.pop()
  const totalBytes = Buffer.byteLength(value, "utf-8")
  if (lines.length <= ToolOutput.MAX_LINES && totalBytes <= ToolOutput.MAX_BYTES) return value
  const kept: string[] = []
  let bytes = 0
  let hitBytes = false
  for (const line of lines.slice(0, ToolOutput.MAX_LINES)) {
    const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
    if (bytes + size > ToolOutput.MAX_BYTES) {
      hitBytes = true
      break
    }
    kept.push(line)
    bytes += size
  }
  const removed = hitBytes ? totalBytes - bytes : lines.length - kept.length
  return `${kept.join("\n")}\n\n...${removed} ${hitBytes ? "bytes" : "lines"} truncated...`
}

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
    resume?: boolean
  },
) {
  if (input.status === "running") return
  const recovery = input.recovery
  const text = bound(
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : "Subagent cancelled",
  )
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${input.status}" description="${recovery.description}">\n${text}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: input.status },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
