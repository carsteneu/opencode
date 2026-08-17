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

type TaskInfo = { status: ToolPart["state"]["status"]; error?: string; background?: boolean }

function lastTaskForChild(parentMessages: Message[], parts: Record<string, Part[] | undefined>, childID: string): TaskInfo | undefined {
  let found: TaskInfo | undefined
  for (const message of parentMessages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool" || part.tool !== "task") continue
      if (part.metadata?.sessionId !== childID) continue
      found = {
        status: part.state.status,
        ...(part.state.status === "error" ? { error: part.state.error } : {}),
        ...(part.metadata?.background === true ? { background: true } : {}),
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

export function deriveAgentRows(input: {
  parentID: string
  sessions: Session[]
  status: Record<string, SessionStatus | undefined>
  messages: Record<string, Message[] | undefined>
  parts: Record<string, Part[] | undefined>
}): AgentRow[] {
  const children = input.sessions
    .filter((x) => x.parentID === input.parentID)
    .toSorted((a, b) => a.time.created - b.time.created)
  if (children.length === 0) return []

  const parentMessages = input.messages[input.parentID] ?? []

  return children.map((child) => {
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
    }
  })
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
