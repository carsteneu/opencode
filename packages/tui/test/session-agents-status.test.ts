import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { DONE_TURN_EXPIRY, MAX_FINISHED_ROWS, deriveAgentRows, formatDuration } from "../src/routes/session/agents-status"

type SubagentState = "streaming" | "running" | "completed" | "error"

function session(id: string, parentID: string | undefined, title: string, created = 1_000): SessionInfo {
  return {
    id,
    parentID,
    title,
    projectID: "proj_test",
    location: { directory: "/tmp/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created + 1_000 },
  } as unknown as SessionInfo
}

function subagentPart(
  id: string,
  childID: string,
  state: SubagentState,
  options: { metadata?: Record<string, unknown>; time?: { created: number; completed?: number } } = {},
): SessionMessageAssistantTool {
  const metadata = options.metadata ?? { sessionID: childID }
  const base = { type: "tool", id, name: "subagent", time: options.time ?? { created: 1, completed: 2 } }
  if (state === "error") {
    return {
      ...base,
      state: { status: "error", input: {}, error: { type: "tool", message: "boom" }, metadata },
    } as unknown as SessionMessageAssistantTool
  }
  if (state === "completed") {
    return {
      ...base,
      state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }], metadata },
    } as unknown as SessionMessageAssistantTool
  }
  return { ...base, time: { created: 1 }, state: { status: state, input: {}, metadata } } as unknown as SessionMessageAssistantTool
}

function assistantMessage(
  id: string,
  content: readonly unknown[],
  time: { created: number; completed?: number } = { created: 1 },
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time,
    content,
  } as unknown as SessionMessageInfo
}

function userMessage(id: string, created: number): SessionMessageInfo {
  return { id, type: "user", text: "prompt", time: { created } } as unknown as SessionMessageInfo
}

function runningTool(id: string, name: string, ran: number, created = ran): unknown {
  return { type: "tool", id, name, time: { created, ran }, state: { status: "running", input: {}, metadata: {} } }
}

function input(rows: {
  sessions?: SessionInfo[]
  status?: Record<string, "idle" | "running">
  messages?: Record<string, SessionMessageInfo[]>
  dismissed?: readonly string[]
}) {
  return {
    parentID: "ses_parent",
    sessions: rows.sessions ?? [],
    status: rows.status ?? {},
    messages: rows.messages ?? {},
    ...(rows.dismissed ? { dismissed: rows.dismissed } : {}),
  }
}

const parent = session("ses_parent", undefined, "Parent session")
const child = session("ses_child_a", "ses_parent", "Probe render path (@explore subagent)")
const child2 = session("ses_child_b", "ses_parent", "Run tests (@general subagent)")
const grandchild = session("ses_grand", "ses_child_a", "Nested (@explore subagent)")

describe("deriveAgentRows", () => {
  test("returns empty for no children", () => {
    expect(deriveAgentRows(input({ sessions: [parent] }))).toEqual([])
  })

  test("ignores grandchildren and the parent itself", () => {
    const rows = deriveAgentRows(input({ sessions: [parent, child, grandchild], status: { ses_grand: "running" } }))
    expect(rows.map((row) => row.id)).toEqual(["ses_child_a"])
  })

  test("runs while the child session is busy", () => {
    const rows = deriveAgentRows(input({ sessions: [parent, child], status: { ses_child_a: "running" } }))
    expect(rows[0]).toMatchObject({ id: "ses_child_a", state: "running" })
  })

  test("runs while the parent's subagent part is still streaming", () => {
    const parentMessages = [assistantMessage("m1", [subagentPart("t1", "ses_child_a", "streaming")])]
    const rows = deriveAgentRows(
      input({ sessions: [parent, child], status: { ses_child_a: "running" }, messages: { ses_parent: parentMessages } }),
    )
    expect(rows[0]).toMatchObject({ state: "running" })
  })

  test("completes when the part is done and the child went idle", () => {
    const parentMessages = [assistantMessage("m1", [subagentPart("t1", "ses_child_a", "completed")])]
    const rows = deriveAgentRows(input({ sessions: [parent, child], messages: { ses_parent: parentMessages } }))
    expect(rows[0]).toMatchObject({ state: "done" })
  })

  test("keeps running when a promoted background subagent outlives its completed part", () => {
    const part = subagentPart("t1", "ses_child_a", "completed", {
      metadata: { sessionID: "ses_child_a", status: "running" },
    })
    const rows = deriveAgentRows(
      input({ sessions: [parent, child], status: { ses_child_a: "running" }, messages: { ses_parent: [assistantMessage("m1", [part])] } }),
    )
    expect(rows[0]).toMatchObject({ state: "running" })
  })

  test("fails with the part error message", () => {
    const parentMessages = [assistantMessage("m1", [subagentPart("t1", "ses_child_a", "error")])]
    const rows = deriveAgentRows(input({ sessions: [parent, child], messages: { ses_parent: parentMessages } }))
    expect(rows[0]).toMatchObject({ state: "failed", reason: "boom" })
  })

  test("waits while the child's active assistant message is scheduled for retry", () => {
    const retrying = {
      ...(assistantMessage("c1", [], { created: 5 }) as object),
      retry: { attempt: 2, at: 6, error: { type: "api", message: "overloaded" } },
    } as unknown as SessionMessageInfo
    const rows = deriveAgentRows(
      input({
        sessions: [parent, child],
        status: { ses_child_a: "running" },
        messages: { ses_parent: [], ses_child_a: [retrying] },
      }),
    )
    expect(rows[0]).toMatchObject({ state: "waiting", reason: "overloaded" })
  })

  test("reports the child's newest running tool as the row detail", () => {
    const childMessages = [
      assistantMessage("c1", [runningTool("tool_2", "grep", 9)], { created: 3 }),
    ]
    const rows = deriveAgentRows(
      input({
        sessions: [parent, child],
        status: { ses_child_a: "running" },
        messages: { ses_parent: [], ses_child_a: childMessages },
      }),
    )
    expect(rows[0]).toMatchObject({ state: "running", detail: "grep", detailSince: 9 })
  })

  test("omits the detail once the newest assistant message has no running tool", () => {
    const childMessages = [assistantMessage("c1", [{ type: "text", text: "done" }], { created: 3 })]
    const rows = deriveAgentRows(
      input({
        sessions: [parent, child],
        status: { ses_child_a: "running" },
        messages: { ses_parent: [], ses_child_a: childMessages },
      }),
    )
    expect(rows[0]).toMatchObject({ state: "running" })
    expect(rows[0]?.detail).toBeUndefined()
  })

  test("expires a finished row after the parent's user turns pass the threshold", () => {
    const part = subagentPart("t1", "ses_child_a", "completed", { time: { created: 1, completed: 10 } })
    const turns = (count: number) => Array.from({ length: count }, (_, index) => userMessage(`u${index}`, 20 + index))
    const kept = deriveAgentRows(
      input({ sessions: [parent, child], messages: { ses_parent: [assistantMessage("m1", [part]), ...turns(DONE_TURN_EXPIRY - 1)] } }),
    )
    const expired = deriveAgentRows(
      input({ sessions: [parent, child], messages: { ses_parent: [assistantMessage("m1", [part]), ...turns(DONE_TURN_EXPIRY)] } }),
    )
    expect(kept.map((row) => row.id)).toEqual(["ses_child_a"])
    expect(expired).toEqual([])
  })

  test("keeps at most MAX_FINISHED_ROWS finished rows, dropping the oldest completion", () => {
    const children = Array.from({ length: MAX_FINISHED_ROWS + 2 }, (_, index) =>
      session(`ses_done_${index}`, "ses_parent", `Done ${index}`, 100 + index),
    )
    const parentMessages = children.map((item, index) =>
      assistantMessage(`m${index}`, [
        subagentPart(`t${index}`, item.id, "completed", { time: { created: 1, completed: 100 + index } }),
      ]),
    )
    const rows = deriveAgentRows(input({ sessions: [parent, ...children], messages: { ses_parent: parentMessages } }))
    expect(rows).toHaveLength(MAX_FINISHED_ROWS)
    expect(rows.map((row) => row.id)).toEqual(
      children.slice(-MAX_FINISHED_ROWS).map((item) => item.id),
    )
  })

  test("omits dismissed children", () => {
    const rows = deriveAgentRows(
      input({ sessions: [parent, child, child2], status: { ses_child_b: "running" }, dismissed: ["ses_child_b"] }),
    )
    expect(rows.map((row) => row.id)).toEqual(["ses_child_a"])
  })

  test("derives the agent label from the title suffix when the session carries none", () => {
    const rows = deriveAgentRows(input({ sessions: [parent, child], status: { ses_child_a: "running" } }))
    expect(rows[0]).toMatchObject({ title: "Probe render path", agent: "explore" })
  })

  test("prefers the session agent over the title suffix", () => {
    const labelled = { ...(child as object), agent: "build" } as unknown as SessionInfo
    const rows = deriveAgentRows(input({ sessions: [parent, labelled], status: { ses_child_a: "running" } }))
    expect(rows[0]).toMatchObject({ agent: "build" })
  })
})

describe("formatDuration", () => {
  test("formats seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(65_000)).toBe("1:05")
    expect(formatDuration(3_600_000)).toBe("1:00:00")
    expect(formatDuration(-1)).toBe("0s")
  })
})
