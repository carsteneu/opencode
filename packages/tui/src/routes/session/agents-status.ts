import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"

export type AgentState = "running" | "waiting" | "done" | "failed"

export type AgentRow = {
  id: string
  title: string
  agent: string
  state: AgentState
  reason?: string
  detail?: string
  detailSince?: number
  startedAt: number
}

const AGENT_SUFFIX = /\s*\(@(\w+) subagent\)$/

function parseTitle(raw: string) {
  const match = raw.match(AGENT_SUFFIX)
  if (!match) return { title: raw, agent: undefined }
  return { title: raw.slice(0, match.index), agent: match[1] }
}

type SubagentState = "streaming" | "running" | "completed" | "error"
type TaskInfo = { status: SubagentState; error?: string; background?: boolean; finishedAt?: number }

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function lastTaskForChild(parentMessages: readonly SessionMessageInfo[], childID: string): TaskInfo | undefined {
  let found: TaskInfo | undefined
  for (const message of parentMessages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "subagent") continue
      const state = part.state
      // The child session id only exists once the call carries metadata.
      if (state.status === "streaming") continue
      const metadata = state.metadata ?? {}
      if ((text(metadata.sessionID) ?? text(metadata.sessionId)) !== childID) continue
      found = {
        status: state.status,
        ...(state.status === "error" ? { error: state.error.message } : {}),
        // Background and timeout-promoted subagents complete the part while the child keeps
        // running, so a completed part alone must not read as done.
        ...(state.status === "completed" && metadata.status === "running" ? { background: true } : {}),
        ...(part.time.completed === undefined ? {} : { finishedAt: part.time.completed }),
      }
    }
  }
  return found
}

function retryOf(childMessages: readonly SessionMessageInfo[] | undefined) {
  const active = (childMessages ?? []).findLast(
    (message) => message.type === "assistant" && message.time.completed === undefined,
  )
  return active?.type === "assistant" ? active.retry : undefined
}

function currentToolDetail(childMessages: readonly SessionMessageInfo[] | undefined) {
  if (!childMessages) return undefined
  for (let i = childMessages.length - 1; i >= 0; i--) {
    const message = childMessages[i]
    if (!message || message.type !== "assistant") continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]
      if (part?.type !== "tool" || part.state.status !== "running") continue
      return {
        detail: text(part.state.metadata?.title) ?? part.name,
        detailSince: part.time.ran ?? part.time.created,
      }
    }
    // The newest assistant message decided the detail; older messages are done.
    return undefined
  }
  return undefined
}

// Finished (done/failed) rows expire after this many parent user turns following completion,
// and at most this many finished rows stay visible (oldest completion expires first).
export const DONE_TURN_EXPIRY = 10
export const MAX_FINISHED_ROWS = 5

type DerivedRow = AgentRow & { finishedAt?: number }

function countTurnsAfter(times: readonly number[], threshold: number) {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) <= threshold) lo = mid + 1
    else hi = mid
  }
  return times.length - lo
}

export function deriveAgentRows(input: {
  parentID: string
  sessions: readonly SessionInfo[]
  /** Session activity by id, as reported by the client store. */
  status: Record<string, "idle" | "running" | undefined>
  messages: Record<string, readonly SessionMessageInfo[] | undefined>
  dismissed?: readonly string[]
}): AgentRow[] {
  const children = input.sessions
    .filter((session) => session.parentID === input.parentID)
    .toSorted((a, b) => a.time.created - b.time.created)
  if (children.length === 0) return []

  const parentMessages = input.messages[input.parentID] ?? []
  // Parent user turns, collected once, newest gate for turn-based expiry.
  const userTurns = parentMessages
    .filter((message) => message.type === "user")
    .map((message) => message.time.created)
    .toSorted((a, b) => a - b)

  const dismissed = new Set(input.dismissed ?? [])

  const rows: DerivedRow[] = children
    .filter((child) => !dismissed.has(child.id))
    .map((child) => {
      const parsed = parseTitle(withTimestampedFallback(child))
      const task = lastTaskForChild(parentMessages, child.id)
      const active = input.status[child.id] === "running"
      const retry = active ? retryOf(input.messages[child.id]) : undefined
      const activity = active ? currentToolDetail(input.messages[child.id]) : undefined

      let state: AgentState
      let reason: string | undefined
      const partDone = task?.status === "completed" && !(task.background && active)
      if (task?.status === "error") {
        state = "failed"
        reason = task.error
      } else if (retry) {
        state = "waiting"
        reason = retry.error.message
      } else if (partDone) {
        state = "done"
      } else if (task?.status === "running") {
        state = "running"
      } else if (active) {
        state = "running"
      } else {
        state = "done"
      }

      return {
        id: child.id,
        title: parsed.title,
        agent: child.agent ?? parsed.agent ?? "subagent",
        state,
        ...(reason === undefined ? {} : { reason }),
        ...(state === "running" && activity ? { detail: activity.detail, detailSince: activity.detailSince } : {}),
        startedAt: child.time.created,
        ...(state === "done" || state === "failed" ? { finishedAt: task?.finishedAt ?? child.time.updated } : {}),
      }
    })

  const expired = new Set<string>()
  for (const row of rows) {
    if (row.finishedAt === undefined) continue
    if (countTurnsAfter(userTurns, row.finishedAt) >= DONE_TURN_EXPIRY) expired.add(row.id)
  }

  const finished = rows.filter((row) => row.finishedAt !== undefined && !expired.has(row.id))
  const over = finished.length - MAX_FINISHED_ROWS
  if (over > 0) {
    const oldest = finished.toSorted((a, b) => (a.finishedAt as number) - (b.finishedAt as number)).slice(0, over)
    for (const row of oldest) expired.add(row.id)
  }

  return rows.filter((row) => !expired.has(row.id))
}

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes)
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
