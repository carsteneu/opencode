import { describe, expect, test } from "bun:test"
import {
  buildReplaySteps,
  buildTranscriptRows,
  clampPatchLines,
  clampReplayPaneWidth,
  filetypeFromPath,
  parseReplayPaneWidth,
  sanitizeText,
  timeLabel,
  type RawMessage,
} from "./replay-lib"

function msg(id: string, role: string, parts: RawMessage["parts"]): RawMessage {
  return { info: { id, role, time: { created: 1700000000000 } }, parts }
}

function editPart(filePath: string, opts: { status?: string; patch?: string; diff?: string } = {}): RawMessage["parts"][number] {
  return {
    type: "tool",
    tool: "edit",
    state: {
      status: opts.status ?? "completed",
      input: { filePath },
      metadata: {
        ...(opts.patch !== undefined ? { filediff: { patch: opts.patch } } : {}),
        ...(opts.diff !== undefined ? { diff: opts.diff } : {}),
      },
    },
  }
}

const FIXTURE: RawMessage[] = [
  msg("m1", "user", [{ type: "text", text: "fix the bug" }]),
  msg("m2", "assistant", [
    { type: "text", text: "on it" },
    editPart("src/a.ts", { patch: "+fixed\n-old" }),
    { type: "tool", tool: "grep", state: { status: "completed" } },
    editPart("src/b.ts", { status: "pending" }),
  ]),
  msg("m3", "assistant", [
    editPart("src/c.ts", { diff: "+only diff" }),
  ]),
]

describe("buildReplaySteps", () => {
  test("collects completed edit/write/apply_patch calls in message order", () => {
    const steps = buildReplaySteps(FIXTURE)
    expect(steps.map((s) => [s.messageID, s.filePath])).toEqual([
      ["m2", "src/a.ts"],
      ["m3", "src/c.ts"],
    ])
  })

  test("patch falls back from filediff.patch to metadata.diff", () => {
    const steps = buildReplaySteps(FIXTURE)
    expect(steps[0]?.patch).toBe("+fixed\n-old")
    expect(steps[1]?.patch).toBe("+only diff")
  })

  test("step indices are 1-based and sequential", () => {
    const steps = buildReplaySteps(FIXTURE)
    expect(steps.map((s) => s.index)).toEqual([1, 2])
  })

  test("empty input yields empty steps", () => {
    expect(buildReplaySteps([])).toEqual([])
  })

  test("completed edit without payload becomes a step with undefined patch", () => {
    const steps = buildReplaySteps([msg("m1", "assistant", [editPart("src/d.ts")])])
    expect(steps).toHaveLength(1)
    expect(steps[0]?.patch).toBeUndefined()
  })

  test("write tool and file_path fallback are handled", () => {
    const message = msg("m1", "assistant", [
      { type: "tool", tool: "write", state: { status: "completed", input: { file_path: "src/e.ts" }, metadata: { filediff: { patch: "+x" } } } },
    ])
    const steps = buildReplaySteps([message])
    expect(steps[0]?.tool).toBe("write")
    expect(steps[0]?.filePath).toBe("src/e.ts")
  })
})

describe("buildTranscriptRows", () => {
  test("emits user and assistant text plus one row per tool call", () => {
    const rows = buildTranscriptRows(FIXTURE)
    expect(rows.map((r) => r.kind)).toEqual([
      "user", "assistant", "tool", "tool", "tool",
    ])
  })

  test("tool rows reference their message", () => {
    const rows = buildTranscriptRows(FIXTURE)
    const toolRows = rows.filter((r) => r.kind === "tool")
    expect(toolRows.map((r) => r.messageID)).toEqual(["m2", "m2", "m3"])
  })
})

describe("timeLabel", () => {
  test("renders a time or an empty string when missing", () => {
    expect(timeLabel(1700000000000)).toContain(":")
    expect(timeLabel(undefined)).toBe("")
  })
})

describe("sanitizeText", () => {
  test("strips ANSI escapes and control characters", () => {
    expect(sanitizeText("\x1b[31mred\x1b[0m")).toBe("red")
    expect(sanitizeText("ok\x07bell\x00null")).toBe("okbellnull")
    expect(sanitizeText("keep\nnewlines")).toBe("keep\nnewlines")
  })

  test("step filePath and patch payloads are sanitized", () => {
    const message = msg("m1", "assistant", [
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "a\x1b[1m.ts" }, metadata: { filediff: { patch: "+\x1b[32mgreen" } } } },
    ])
    const steps = buildReplaySteps([message])
    expect(steps[0]?.filePath).toBe("a.ts")
    expect(steps[0]?.patch).toBe("+green")
  })

  test("clampPatchLines truncates with a marker", () => {
    const clamped = clampPatchLines("+1\n+2\n+3", 2)
    expect(clamped).toBe("+1\n+2\n… (truncated)")
    expect(clampPatchLines("+1", 2)).toBe("+1")
  })
})

describe("parseReplayPaneWidth", () => {
  test("passes through finite numbers within bounds", () => {
    expect(parseReplayPaneWidth(36)).toBe(36)
    expect(parseReplayPaneWidth(24)).toBe(24)
    expect(parseReplayPaneWidth(60)).toBe(60)
  })

  test("clamps out-of-bounds numbers", () => {
    expect(parseReplayPaneWidth(0)).toBe(24)
    expect(parseReplayPaneWidth(-5)).toBe(24)
    expect(parseReplayPaneWidth(100)).toBe(60)
  })

  test("returns the default for missing or non-numeric values", () => {
    expect(parseReplayPaneWidth(undefined)).toBe(36)
    expect(parseReplayPaneWidth(null)).toBe(36)
    expect(parseReplayPaneWidth("")).toBe(36)
    expect(parseReplayPaneWidth("abc")).toBe(36)
    expect(parseReplayPaneWidth({})).toBe(36)
  })

  test("accepts numeric strings and rounds floats", () => {
    expect(parseReplayPaneWidth("44")).toBe(44)
    expect(parseReplayPaneWidth("12")).toBe(24)
    expect(parseReplayPaneWidth(48.7)).toBe(49)
  })
})

describe("clampReplayPaneWidth", () => {
  test("rounds and clamps to the 24-60 range", () => {
    expect(clampReplayPaneWidth(30.2)).toBe(30)
    expect(clampReplayPaneWidth(Number.NaN)).toBe(36)
  })
})

describe("filetypeFromPath", () => {
  test("maps common extensions to tree-sitter languages", () => {
    expect(filetypeFromPath("src/app.py")).toBe("python")
    expect(filetypeFromPath("src/lib.go")).toBe("go")
    expect(filetypeFromPath("src/main.rs")).toBe("rust")
    expect(filetypeFromPath("styles.css")).toBe("css")
  })

  test("normalizes react/javascript languages to typescript like the diff viewer", () => {
    expect(filetypeFromPath("src/App.tsx")).toBe("typescript")
    expect(filetypeFromPath("src/App.jsx")).toBe("typescript")
    expect(filetypeFromPath("src/util.mjs")).toBe("typescript")
  })

  test("returns undefined for unknown extensions and none for missing paths", () => {
    expect(filetypeFromPath("data.unknownext")).toBeUndefined()
    expect(filetypeFromPath("")).toBe("none")
    expect(filetypeFromPath(undefined)).toBe("none")
  })
})
