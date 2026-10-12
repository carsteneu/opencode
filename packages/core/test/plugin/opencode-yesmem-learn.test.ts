import { describe, expect, test } from "bun:test"
import { fakeContext, loadPlugin, mockDaemon, withSocket, type DaemonRequest } from "./opencode-yesmem-fixture"

const daemonHandler = (request: DaemonRequest) => {
  if (request.method === "remember") return { result: { ok: true } }
  if (request.method === "hybrid_search")
    return { result: { results: [{ category: "gotcha", content: "similar issue seen before" }] } }
  if (request.method === "resolve_by_text") return { result: { resolved: 1 } }
  return { result: {} }
}

const methods = (requests: DaemonRequest[]) => requests.map((request) => request.method)

describe("failure_learn", () => {
  test("records a failing tool call and attaches matching learnings to the error", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/learn")
        await loadPlugin(recorder)

        const event = await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_learn",
          id: "call_fail",
          input: { command: "node build.js" },
          status: "error",
          error: { message: "Error: cannot find module 'left-pad'" },
        })

        expect(event.failed).toBe(false)
        const requests = daemon.hooked()
        expect(methods(requests)).toEqual(["remember", "hybrid_search"])
        expect(requests[0].params.text).toContain("cannot find module")
        expect(requests[0].params.category).toBe("gotcha")
        expect(requests[0].params.project).toBe("/workspace/learn")
        expect(String(event.event.error.message)).toContain("[YesMem Assist]")
        expect(String(event.event.error.message)).toContain("similar issue seen before")
      })
    } finally {
      await daemon.close()
    }
  })

  test("ignores short failures and harmless navigation commands", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/learn2")
        await loadPlugin(recorder)

        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_learn",
          id: "call_short",
          input: { command: "node build.js" },
          status: "error",
          error: { message: "short" },
        })
        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_learn",
          id: "call_grep",
          input: { command: "grep -r nothing ." },
          status: "error",
          error: { message: "Error: no matches were found in any of the given files" },
        })

        expect(methods(daemon.hooked())).toEqual([])
      })
    } finally {
      await daemon.close()
    }
  })

  test("leaves a successful call alone", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/learn3")
        await loadPlugin(recorder)

        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_learn",
          id: "call_ok",
          input: { command: "node build.js" },
          status: "completed",
          result: { content: "built" },
        })

        expect(methods(daemon.hooked())).toEqual([])
      })
    } finally {
      await daemon.close()
    }
  })
})

describe("hook resilience", () => {
  test("a callback that throws does not fail its hook", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/resilient")
        await loadPlugin(recorder)

        // Reading event.error throws; the after chain must still complete (auto_resolve included).
        const event: Record<string, any> = {
          tool: "shell",
          sessionID: "ses_resilient",
          id: "call_throwing",
          input: { command: "node build.js" },
          status: "error",
        }
        Object.defineProperty(event, "error", {
          get() {
            throw new Error("host event access failed")
          },
        })

        const result = await recorder.fire("tool.execute.after", event)
        expect(result.failed).toBe(false)
      })
    } finally {
      await daemon.close()
    }
  })
})

describe("auto_resolve", () => {
  test("resolves open tasks from a git commit message", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/resolve")
        await loadPlugin(recorder)

        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_resolve",
          id: "call_commit",
          input: { command: 'git commit -m "fix the flaky test"' },
          status: "completed",
          result: { content: "committed" },
        })

        const requests = daemon.hooked()
        expect(methods(requests)).toEqual(["resolve_by_text"])
        expect(requests[0].params).toEqual({ text: "fix the flaky test", project: "/workspace/resolve" })
      })
    } finally {
      await daemon.close()
    }
  })

  test("does not resolve tasks when the commit failed", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/resolve3")
        await loadPlugin(recorder)

        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_resolve",
          id: "call_rejected",
          input: { command: 'git commit -m "fix the flaky test"' },
          status: "error",
          error: { message: "pre-commit hook rejected the commit" },
        })

        expect(daemon.hooked().some((request) => request.method === "resolve_by_text")).toBe(false)
      })
    } finally {
      await daemon.close()
    }
  })

  test("ignores commands that are not commit messages", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/resolve2")
        await loadPlugin(recorder)

        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_resolve",
          id: "call_amend",
          input: { command: "git commit --amend --no-edit" },
          status: "completed",
          result: { content: "ok" },
        })
        await recorder.fire("tool.execute.after", {
          tool: "shell",
          sessionID: "ses_resolve",
          id: "call_else",
          input: { command: "git status" },
          status: "completed",
          result: { content: "ok" },
        })

        expect(methods(daemon.hooked())).toEqual([])
      })
    } finally {
      await daemon.close()
    }
  })
})
