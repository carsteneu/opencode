import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"

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
  if (!match) return { title: raw, agent: "subagent" }
  return { title: raw.slice(0, match.index), agent: match[1] }
}

type TaskInfo = { status: ToolPart["state"]["status"]; error?: string; background?: boolean; finishedAt?: number }

function lastTaskForChild(parentMessages: Message[], parts: Record<string, Part[] | undefined>, childID: string): TaskInfo | undefined {
  let found: TaskInfo | undefined
  for (const message of parentMessages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool" || part.tool !== "task") continue
      if (part.metadata?.sessionId !== childID) continue
      const state = part.state
      const end = state.status === "completed" || state.status === "error" ? state.time?.end : undefined
      found = {
        status: state.status,
        ...(state.status === "error" ? { error: state.error } : {}),
        ...(part.metadata?.background === true ? { background: true } : {}),
        ...(typeof end === "number" ? { finishedAt: end } : {}),
      }
    }
  }
  return found
}

function currentToolDetail(childMessages: Message[] | undefined, parts: Record<string, Part[] | undefined>) {
  if (!childMessages) return undefined
  for (let i = childMessages.length - 1; i >= 0; i--) {
    const message = childMessages[i]
    if (message.role !== "assistant") continue
    const messageParts = parts[message.id] ?? []
    for (let j = messageParts.length - 1; j >= 0; j--) {
      const part = messageParts[j]
      if (part.type !== "tool" || part.state.status !== "running") continue
      const running = part.state
      return {
        detail: running.title ?? part.tool,
        detailSince: running.time.start,
      }
    }
    // newest assistant message decided the detail; older messages are done
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
    if (times[mid] <= threshold) lo = mid + 1
    else hi = mid
  }
  return times.length - lo
}

export function deriveAgentRows(input: {
  parentID: string
  sessions: Session[]
  status: Record<string, SessionStatus | undefined>
  messages: Record<string, Message[] | undefined>
  parts: Record<string, Part[] | undefined>
  dismissed?: readonly string[]
}): AgentRow[] {
  const children = input.sessions
    .filter((x) => x.parentID === input.parentID)
    .toSorted((a, b) => a.time.created - b.time.created)
  if (children.length === 0) return []

  const parentMessages = input.messages[input.parentID] ?? []
  // Parent user turns, collected once, newest gate for turn-based expiry.
  const userTurns = parentMessages
    .filter((m) => m.role === "user")
    .map((m) => m.time.created)
    .toSorted((a, b) => a - b)

  const dismissed = new Set(input.dismissed ?? [])

  const rows: DerivedRow[] = children
    .filter((child) => !dismissed.has(child.id))
    .map((child) => {
      const { title, agent } = parseTitle(child.title)
      const task = lastTaskForChild(parentMessages, input.parts, child.id)
      const status = input.status[child.id]
      const activity = status?.type === "busy" ? currentToolDetail(input.messages[child.id], input.parts) : undefined

      let state: AgentState
      let reason: string | undefined
      // A completed task part does not mean the child finished: background and
      // timeout-promoted subagents complete the part while the child keeps running.
      const partDone = task?.status === "completed" && !(task.background && status?.type === "busy")
      if (task?.status === "error") {
        state = "failed"
        reason = task.error
      } else if (status?.type === "retry") {
        state = "waiting"
        reason = status.message
      } else if (partDone) {
        state = "done"
      } else if (task?.status === "running" || task?.status === "pending") {
        state = "running"
      } else if (status?.type === "busy") {
        state = "running"
      } else {
        state = "done"
      }

      return {
        id: child.id,
        title,
        agent,
        state,
        ...(reason !== undefined ? { reason } : {}),
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
    const oldest = finished.toSorted((a, b) => a.finishedAt! - b.finishedAt!).slice(0, over)
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
