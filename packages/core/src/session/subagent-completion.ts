export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import { ToolOutput } from "../tool-output.js"
import type { SessionBackground } from "./background.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"

export const NO_TEXT = "Subagent completed without a text response."

export type RunningBackgroundItem = SessionBackground.OutstandingItem

/** A Session handle narrow enough for both Session.Service and SessionExecution to deliver a report. */
export interface SyntheticSession<E = never> {
  readonly synthetic: (input: {
    readonly id?: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly text: string
    readonly description?: string
    readonly metadata?: SessionSchema.Metadata
  }) => Effect.Effect<unknown, E>
}

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
// than Location-scoped, so the full text is dropped instead of persisted. v1
// also wrote the full output to disk; that pointer is not available here, so the
// note states what was dropped without an over-approximate byte figure.
export function bound(value: string) {
  const lines = value.split("\n")
  if (value.endsWith("\n")) lines.pop()
  if (lines.length <= ToolOutput.MAX_LINES && Buffer.byteLength(value, "utf-8") <= ToolOutput.MAX_BYTES) return value
  const kept: string[] = []
  let bytes = 0
  for (const line of lines.slice(0, ToolOutput.MAX_LINES)) {
    const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
    if (bytes + size > ToolOutput.MAX_BYTES) break
    kept.push(line)
    bytes += size
  }
  // A single line longer than the whole budget keeps its beginning: replacing the subagent's output with
  // nothing but a truncation note would tell the parent less than a clipped first line does.
  const capped = kept.length === 0 && lines.length > 0
  if (capped) {
    const head = Buffer.from(lines[0]!, "utf-8").subarray(0, ToolOutput.MAX_BYTES)
    const text = head.toString("utf-8").replace(/\uFFFD$/, "")
    return `${text}\n\n...${Buffer.byteLength(lines[0]!, "utf-8") - Buffer.byteLength(text, "utf-8")} bytes truncated...`
  }
  if (kept.length === lines.length) return value
  return `${kept.join("\n")}\n\n...${lines.length - kept.length} lines truncated...`
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim()

const STILL_RUNNING = "\n\nBackground work still running:\n"

export function formatBody(
  body: string,
  childSessionID: SessionSchema.ID,
  background?: ReadonlyArray<RunningBackgroundItem>,
): string {
  if (!background || background.length === 0) return body
  const lines = background.map((item) => {
    if (item.kind === "shell")
      return `- shell (${item.shellID}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${clean(item.command)}`
    if (item.kind === "image")
      return `- image (${item.model}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${item.path}`
    return `- subagent (${item.agent}, sessionID: ${item.childSessionID}): ${clean(item.description)}`
  })
  return `${body}${STILL_RUNNING}${lines.join("\n")}`
}

export const deliver = Effect.fnUntraced(function* <E>(
  sessions: SyntheticSession<E>,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
  },
) {
  if (input.status === "running") return
  const recovery = input.recovery
  const body =
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : (input.output ?? input.error ?? "Subagent cancelled")
  // The body is all a recovered outbox row keeps, so the still-running list is how a replay tells this period apart.
  // Only the model-facing tag says "running": the job and the message metadata keep the period's real status.
  const state = input.status === "completed" && body.includes(STILL_RUNNING) ? "running" : input.status
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${state}" description="${recovery.description}">\n${bound(body)}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: input.status },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
