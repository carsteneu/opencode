import { describe, expect, test } from "bun:test"
import { buildReplaySteps, buildTranscriptRows, timeLabel, type RawMessage } from "./replay-lib"

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
