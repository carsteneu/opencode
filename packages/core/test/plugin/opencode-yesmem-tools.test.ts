import { describe, expect, test } from "bun:test"
import {
  fakeContext,
  loadPlugin,
  mockDaemon,
  withSocket,
  yesmemEntry,
  type DaemonRequest,
  type HookResult,
} from "./opencode-yesmem-fixture"

type CodeNavModule = { isNonCodeFile: (relativePath: string) => boolean }

const indexed = (request: DaemonRequest) => {
  if (request.method === "search_code_index") return { result: { text: "Found 12 matches" } }
  if (request.method === "get_file_symbols") return { result: { text: "src/foo.ts:12 func Foo" } }
  if (request.method === "get_file_index") return { result: { text: "src/foo.ts" } }
  return { result: {} }
}

const notIndexed = (request: DaemonRequest) => {
  if (request.method === "search_code_index") return { result: { text: "No results found" } }
  return { result: {} }
}

/** Asserts the call was rejected the way the session runner expects, and returns the message. */
const blocked = (result: HookResult) => {
  expect(result.failed).toBe(true)
  // Only a genuine Tool.Error is turned into a model-visible tool failure by the runner.
  expect(result.error?._tag).toBe("Tool.Error")
  return String(result.error.message)
}

const passed = (result: HookResult) => expect(result.failed).toBe(false)

describe("yesmem tool context injection", () => {
  test("adds the session, source agent and cwd to yesmem_ tool calls", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/a")
        await loadPlugin(recorder)

        const { event, failed } = await recorder.fire("tool.execute.before", {
          tool: "yesmem_search",
          sessionID: "ses_a",
          input: { query: "first" },
        })

        expect(failed).toBe(false)
        expect(event.input).toEqual({
          query: "first",
          _session_id: "opencode:ses_a",
          _source_agent: "opencode",
          _cwd: "/workspace/a",
        })
      })
    } finally {
      await daemon.close()
    }
  })

  test("leaves non-yesmem tool calls untouched", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/b")
        await loadPlugin(recorder)

        const { event, failed } = await recorder.fire("tool.execute.before", {
          tool: "todowrite",
          sessionID: "ses_b",
          input: { todos: [] },
        })

        expect(failed).toBe(false)
        expect(event.input).toEqual({ todos: [] })
      })
    } finally {
      await daemon.close()
    }
  })
})

describe("code_nav shell blocking", () => {
  test("blocks the first shell navigation on an indexed file and allows the retry", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/c")
        await loadPlugin(recorder)

        const first = await recorder.fire("tool.execute.before", {
          tool: "shell",
          sessionID: "ses_c",
          input: { command: "cat src/one.ts" },
        })
        expect(blocked(first)).toContain("YesMem: BLOCKED shell nav")

        // The second attempt on the same file is the escape hatch the message advertises.
        const retry = await recorder.fire("tool.execute.before", {
          tool: "shell",
          sessionID: "ses_c",
          input: { command: "cat src/one.ts" },
        })
        passed(retry)
        expect(retry.event.input.command).toBe("cat src/one.ts")
      })
    } finally {
      await daemon.close()
    }
  })

  test("blocks a source path but never a documentation path", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/d")
        await loadPlugin(recorder)

        // Discriminating half: the same code path must block, otherwise the allow below proves nothing.
        const source = await recorder.fire("tool.execute.before", {
          tool: "shell",
          sessionID: "ses_d",
          input: { command: "cat src/two.ts" },
        })
        expect(blocked(source)).toContain("BLOCKED shell nav")

        passed(
          await recorder.fire("tool.execute.before", {
            tool: "shell",
            sessionID: "ses_d",
            input: { command: "cat docs/notes.md" },
          }),
        )
        passed(
          await recorder.fire("tool.execute.before", {
            tool: "shell",
            sessionID: "ses_d",
            input: { command: "cat LICENSE" },
          }),
        )

        // Documentation paths must not even be looked up in the index.
        expect(
          daemon.hooked().filter((request) => request.method === "get_file_symbols").length,
        ).toBe(1)
      })
    } finally {
      await daemon.close()
    }
  })

  test("blocks on an indexed project but stays inert on an unindexed one", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/e")
        await loadPlugin(recorder)

        const source = await recorder.fire("tool.execute.before", {
          tool: "shell",
          sessionID: "ses_e",
          input: { command: "cat src/three.ts" },
        })
        expect(blocked(source)).toContain("BLOCKED shell nav")
      })
    } finally {
      await daemon.close()
    }

    const empty = await mockDaemon(notIndexed)
    try {
      await withSocket(empty.socketPath, async () => {
        const recorder = fakeContext("/workspace/e2")
        await loadPlugin(recorder)

        passed(
          await recorder.fire("tool.execute.before", {
            tool: "shell",
            sessionID: "ses_e2",
            input: { command: "cat src/three.ts" },
          }),
        )
        expect(empty.hooked().some((request) => request.method === "get_file_symbols")).toBe(false)
      })
    } finally {
      await empty.close()
    }
  })
})

describe("code_nav read blocking", () => {
  test("blocks the first read of an indexed source file and allows the retry", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/f")
        await loadPlugin(recorder)

        const first = await recorder.fire("tool.execute.before", {
          tool: "read",
          sessionID: "ses_f",
          input: { filePath: "src/four.ts" },
        })
        expect(blocked(first)).toContain("YesMem: BLOCKED read")

        passed(
          await recorder.fire("tool.execute.before", {
            tool: "read",
            sessionID: "ses_f",
            input: { filePath: "src/four.ts" },
          }),
        )
      })
    } finally {
      await daemon.close()
    }
  })

  test("blocks a source read but lets documentation reads through", async () => {
    const daemon = await mockDaemon(indexed)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/g")
        await loadPlugin(recorder)

        const first = await recorder.fire("tool.execute.before", {
          tool: "read",
          sessionID: "ses_g",
          input: { filePath: "src/five.ts" },
        })
        expect(blocked(first)).toContain("BLOCKED read")

        passed(
          await recorder.fire("tool.execute.before", {
            tool: "read",
            sessionID: "ses_g",
            input: { filePath: "README.md" },
          }),
        )
        expect(daemon.hooked().filter((request) => request.method === "get_file_symbols").length).toBe(1)
      })
    } finally {
      await daemon.close()
    }
  })
})

describe("code_nav file classification", () => {
  test("separates source files from documentation and build metadata", async () => {
    const module = (await import(yesmemEntry("code_nav.ts"))) as CodeNavModule

    for (const file of [
      "LICENSE",
      "README.md",
      "docs/notes.txt",
      "Dockerfile.dev",
      "Makefile",
      ".gitignore",
      "CHANGELOG.md",
    ])
      expect(module.isNonCodeFile(file)).toBe(true)
    for (const file of ["src/foo.ts", "internal/server.go", "Dockerfilex", "main.go", "a/b/c.py"])
      expect(module.isNonCodeFile(file)).toBe(false)
  })
})
