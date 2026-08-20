import { describe, expect, test } from "bun:test"
import { deriveAgentRows, formatDuration } from "../../src/routes/session/agents-status"
import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"

function session(id: string, parentID: string | undefined, title: string, created = 1_000): Session {
  return {
    id,
    parentID,
    title,
    time: { created, updated: created + 1_000 },
  } as Session
}

function taskPart(
  id: string,
  childID: string,
  status: ToolPart["state"]["status"],
  error?: string,
  time?: { start: number; end?: number },
): Part {
  return {
    id,
    type: "tool",
    tool: "task",
    state: {
      status,
      input: {},
      ...(status === "error" ? { error: error ?? "boom" } : {}),
      ...(status === "running" ? { time: { start: 5_000 } } : {}),
      ...(status === "completed" ? { output: "ok", title: "done", metadata: {}, time: { start: 1, end: 2 } } : {}),
      ...(time ? { time } : {}),
    },
    metadata: { sessionId: childID, parentSessionId: "ses_parent" },
  } as unknown as Part
}

function toolPart(id: string, tool: string, start: number): Part {
  return {
    id,
    type: "tool",
    tool,
    state: { status: "running", input: {}, title: `${tool} file.ts`, time: { start } },
  } as unknown as Part
}

function message(id: string, sessionID: string, role: "assistant" | "user", time: number): Message {
  return { id, sessionID, role, time: { created: time } } as unknown as Message
}

function input(rows: {
  sessions?: Session[]
  status?: Record<string, SessionStatus>
  messages?: Record<string, Message[]>
  parts?: Record<string, Part[]>
  dismissed?: readonly string[]
}) {
  return {
    parentID: "ses_parent",
    sessions: rows.sessions ?? [],
    status: rows.status ?? {},
    messages: rows.messages ?? {},
    parts: rows.parts ?? {},
    ...(rows.dismissed ? { dismissed: rows.dismissed } : {}),
  }
}

const child = session("ses_child_a", "ses_parent", "Probe render path (@explore subagent)")
const child2 = session("ses_child_b", "ses_parent", "Run tests (@general subagent)")
const grandchild = session("ses_grand", "ses_child_a", "Nested (@explore subagent)")
const parent = session("ses_parent", undefined, "Parent session")

describe("deriveAgentRows", () => {
  test("returns empty for no children", () => {
    expect(deriveAgentRows(input({ sessions: [parent] }))).toEqual([])
  })

  test("ignores grandchildren and the parent itself", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [parent, child, grandchild],
        status: { [child.id]: { type: "busy" } },
      }),
    )
    expect(rows.map((x) => x.id)).toEqual([child.id])
  })

  test("running task with busy status and active tool yields running row with detail", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "busy" } },
        messages: {
          ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)],
          [child.id]: [message("msg_c1", child.id, "assistant", 20)],
        },
        parts: {
          msg_p1: [taskPart("prt_task", child.id, "running")],
          msg_c1: [toolPart("prt_read", "read", 40_000)],
        },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("running")
    expect(rows[0].detail).toBe("read file.ts")
    expect(rows[0].detailSince).toBe(40_000)
    expect(rows[0].title).toBe("Probe render path")
    expect(rows[0].agent).toBe("explore")
    expect(rows[0].startedAt).toBe(1_000)
  })

  test("busy child without tool detail still reports running", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "busy" } },
      }),
    )
    expect(rows[0].state).toBe("running")
    expect(rows[0].detail).toBeUndefined()
  })

  test("retry status while task running yields waiting with reason", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "retry", attempt: 2, message: "rate limited", next: 30_000 } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [taskPart("prt_task", child.id, "running")] },
      }),
    )
    expect(rows[0].state).toBe("waiting")
    expect(rows[0].reason).toBe("rate limited")
  })

  test("errored task part yields failed with error reason", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "idle" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [taskPart("prt_task", child.id, "error", "agent crashed")] },
      }),
    )
    expect(rows[0].state).toBe("failed")
    expect(rows[0].reason).toBe("agent crashed")
  })

  test("completed task part yields done even while status map is stale-busy", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "busy" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [taskPart("prt_task", child.id, "completed")] },
      }),
    )
    expect(rows[0].state).toBe("done")
  })

  test("idle child without task part yields done", () => {
    const rows = deriveAgentRows(input({ sessions: [child], status: { [child.id]: { type: "idle" } } }))
    expect(rows[0].state).toBe("done")
  })

  test("child without any status entry yields done", () => {
    const rows = deriveAgentRows(input({ sessions: [child] }))
    expect(rows[0].state).toBe("done")
  })

  test("uses the last task part when a child has several task calls", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "idle" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: {
          msg_p1: [
            taskPart("prt_task_1", child.id, "completed"),
            taskPart("prt_task_2", child.id, "running"),
          ],
        },
      }),
    )
    expect(rows[0].state).toBe("running")
  })

  test("sorts children by creation time", () => {
    const late = session("ses_child_a", "ses_parent", "Late child (@explore subagent)", 3_000)
    const early = session("ses_child_z", "ses_parent", "Early child (@explore subagent)", 2_000)
    const rows = deriveAgentRows(
      input({
        sessions: [late, early],
        status: { [late.id]: { type: "idle" }, [early.id]: { type: "idle" } },
      }),
    )
    expect(rows.map((x) => x.id)).toEqual([early.id, late.id])
  })

  test("backgrounded task part with busy child stays running (timeout/background promotion)", () => {
    const backgroundPart = {
      ...taskPart("prt_task_bg", child.id, "completed"),
      metadata: { sessionId: child.id, parentSessionId: "ses_parent", background: true },
    } as unknown as Part
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "busy" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [backgroundPart] },
      }),
    )
    expect(rows[0].state).toBe("running")
  })

  test("backgrounded task part with idle child is done", () => {
    const backgroundPart = {
      ...taskPart("prt_task_bg", child.id, "completed"),
      metadata: { sessionId: child.id, parentSessionId: "ses_parent", background: true },
    } as unknown as Part
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "idle" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [backgroundPart] },
      }),
    )
    expect(rows[0].state).toBe("done")
  })

  test("pending task part yields running", () => {
    const rows = deriveAgentRows(
      input({
        sessions: [child],
        status: { [child.id]: { type: "busy" } },
        messages: { ses_parent: [message("msg_p1", "ses_parent", "assistant", 10)] },
        parts: { msg_p1: [taskPart("prt_task_pending", child.id, "pending")] },
      }),
    )
    expect(rows[0].state).toBe("running")
  })

    test("falls back to plain title when agent suffix is missing", () => {
      const odd = session("ses_child_c", "ses_parent", "Just a description")
      const rows = deriveAgentRows(input({ sessions: [odd], status: { [odd.id]: { type: "idle" } } }))
      expect(rows[0].title).toBe("Just a description")
      expect(rows[0].agent).toBe("subagent")
    })

    // helper: `count` user turns in the parent, each strictly after `after`
    function userTurns(count: number, after: number): Message[] {
      return Array.from({ length: count }, (_, i) => message(`p_turn_${i}_${after}`, "ses_parent", "user", after + (i + 1) * 10))
    }

    test("done row expires after 10 parent user turns following completion", () => {
      const completed = taskPart("prt_done", child.id, "completed", undefined, { start: 9_000, end: 10_000 })
        const base = { sessions: [child], status: { [child.id]: { type: "idle" } } as Record<string, SessionStatus> }
      const visible = deriveAgentRows(
        input({
          ...base,
          messages: {
            ses_parent: [
              message("p_work", "ses_parent", "assistant", 9_500),
              // a turn at exactly the completion timestamp does not count
              message("p_same", "ses_parent", "user", 10_000),
              ...userTurns(9, 10_000),
            ],
          },
          parts: { p_work: [completed] },
        }),
      )
      expect(visible.map((x) => x.id)).toEqual([child.id])
      const gone = deriveAgentRows(
        input({
          ...base,
          messages: {
            ses_parent: [message("p_work", "ses_parent", "assistant", 9_500), ...userTurns(10, 10_000)],
          },
          parts: { p_work: [completed] },
        }),
      )
      expect(gone).toEqual([])
    })

    test("failed row expires after 10 parent user turns following completion", () => {
      const failed = taskPart("prt_err", child.id, "error", "agent crashed", { start: 9_000, end: 10_000 })
        const base = { sessions: [child], status: { [child.id]: { type: "idle" } } as Record<string, SessionStatus> }
      expect(
        deriveAgentRows(
          input({ ...base, messages: { ses_parent: [message("p_work", "ses_parent", "assistant", 9_500), ...userTurns(9, 10_000)] }, parts: { p_work: [failed] } }),
        ),
      ).toHaveLength(1)
      expect(
        deriveAgentRows(
          input({ ...base, messages: { ses_parent: [message("p_work", "ses_parent", "assistant", 9_500), ...userTurns(10, 10_000)] }, parts: { p_work: [failed] } }),
        ),
      ).toEqual([])
    })

    test("running and waiting rows never expire", () => {
      const running = taskPart("prt_run", child.id, "running")
      const waiting = session("ses_wait", "ses_parent", "Waiter (@explore subagent)")
      const rows = deriveAgentRows(
        input({
          sessions: [child, waiting],
          status: { [child.id]: { type: "busy" }, [waiting.id]: { type: "retry", attempt: 2, message: "rate limited", next: 30_000 } },
          messages: { ses_parent: [message("p_work", "ses_parent", "assistant", 1), ...userTurns(20, 1)] },
          parts: { p_work: [running] },
        }),
      )
      expect(rows).toHaveLength(2)
    })

    test("caps finished rows at 5, dropping the oldest completion first", () => {
      // six finished children with distinct completion times; none expired by turns
      const ids = ["c1", "c2", "c3", "c4", "c5", "c6"].map((n, i) =>
        session(`ses_cap_${n}`, "ses_parent", `Cap child ${n} (@explore subagent)`, 1_000 * (i + 1)),
      )
      const messages: Message[] = [message("p_work", "ses_parent", "assistant", 500)]
      const parts: Record<string, Part[]> = {
        p_work: ids.map((s, i) =>
          taskPart(`prt_cap_${s.id}`, s.id, "completed", undefined, { start: 100, end: 2_000 + i * 1_000 }),
        ),
      }
      const rows = deriveAgentRows(
        input({ sessions: ids, status: Object.fromEntries(ids.map((s) => [s.id, { type: "idle" }])), messages: { ses_parent: messages }, parts }),
      )
      expect(rows).toHaveLength(5)
      expect(rows.map((x) => x.id)).not.toContain("ses_cap_c1") // oldest completion (c1, end 2000) dropped
      expect(rows.map((x) => x.id)).toEqual(expect.arrayContaining(["ses_cap_c2", "ses_cap_c3", "ses_cap_c4", "ses_cap_c5", "ses_cap_c6"]))
    })

    test("running rows do not count against the finished cap", () => {
      const done = ["d1", "d2", "d3", "d4", "d5", "d6"].map((n, i) =>
        session(`ses_capd_${n}`, "ses_parent", `Done child ${n} (@explore subagent)`, 500 + i * 100),
      )
      const live = session("ses_cap_running", "ses_parent", "Live (@explore subagent)")
      const messages: Message[] = [message("p_work", "ses_parent", "assistant", 1)]
      const parts: Record<string, Part[]> = {
        p_work: [
          ...done.map((s, i) => taskPart(`prt_d_${s.id}`, s.id, "completed", undefined, { start: 100, end: 5_000 + i * 100 })),
          taskPart("prt_run", live.id, "running"),
        ],
      }
      const rows = deriveAgentRows(
        input({
          sessions: [...done, live],
          status: { ...Object.fromEntries(done.map((s) => [s.id, { type: "idle" }])), [live.id]: { type: "busy" } },
          messages: { ses_parent: messages },
          parts,
        }),
      )
      expect(rows).toHaveLength(6) // 5 finished (cap) + 1 running
      expect(rows.map((x) => x.id)).toContain(live.id)
    })

    test("finished row without a task part falls back to child update time", () => {
      // child.time.updated = created + 1000 = 10000; 10 user turns strictly after 10000 expire it
      const bare = session("ses_bare", "ses_parent", "No task (@explore subagent)", 9_000)
      const base = { sessions: [bare], status: { [bare.id]: { type: "idle" } } as Record<string, SessionStatus> }
      expect(deriveAgentRows(input({ ...base, messages: { ses_parent: userTurns(9, 10_000) } }))).toHaveLength(1)
      expect(deriveAgentRows(input({ ...base, messages: { ses_parent: userTurns(10, 10_000) } }))).toEqual([])
    })

    test("dismissed child ids are filtered out", () => {
      const other = session("ses_keep", "ses_parent", "Kept (@explore subagent)")
      const rows = deriveAgentRows(
        input({
          sessions: [child, other],
          status: { [child.id]: { type: "idle" }, [other.id]: { type: "idle" } },
          dismissed: [child.id],
        }),
      )
      expect(rows.map((x) => x.id)).toEqual([other.id])
    })
  })

describe("formatDuration", () => {
  test("formats seconds below a minute", () => {
    expect(formatDuration(3_000)).toBe("3s")
    expect(formatDuration(59_900)).toBe("59s")
  })
  test("formats minutes and seconds", () => {
    expect(formatDuration(62_000)).toBe("1:02")
    expect(formatDuration(600_000)).toBe("10:00")
  })
  test("formats hours", () => {
    expect(formatDuration(3_662_000)).toBe("1:01:02")
  })
  test("clamps negative and zero", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(-5_000)).toBe("0s")
  })
})
