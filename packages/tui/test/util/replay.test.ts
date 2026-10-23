import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import {
  clampReplayPatch,
  compactReplayPatch,
  replayFileName,
  replaySteps,
  replayTimeLabel,
  sanitizeReplayText,
} from "../../src/util/replay"

const CREATED = 1700000000000

type ToolState = Extract<SessionMessageAssistant["content"][number], { type: "tool" }>["state"]

function assistant(
  id: string,
  content: SessionMessageAssistant["content"],
  created = CREATED,
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    time: { created },
    content,
  }
}

function tool(
  name: string,
  input: Record<string, unknown>,
  options: { status?: "completed" | "error" | "running" | "streaming"; files?: { patch?: string }[]; diff?: string } = {},
) {
  const state =
    options.status === "error"
      ? { status: "error" as const, input, error: { name: "ToolError", message: "failed" } }
      : options.status === "running" || options.status === "streaming"
        ? { status: options.status, input }
        : {
            status: "completed" as const,
            input,
            content: [{ type: "text" as const, text: "ok" }],
            metadata: {
              ...(options.files === undefined ? {} : { files: options.files }),
              ...(options.diff === undefined ? {} : { diff: options.diff }),
            },
          }
  return { type: "tool" as const, id: `prt_${name}_${Object.keys(input).length}`, name, state: state as ToolState, time: { created: CREATED } }
}

const FIXTURE: SessionMessageInfo[] = [
  { id: "m1", type: "user", text: "fix the bug", time: { created: CREATED } },
  assistant("m2", [
    { type: "text", text: "on it" },
    tool("edit", { path: "src/a.ts" }, { files: [{ patch: "+fixed\n-old" }] }),
    tool("grep", { pattern: "bug" }),
    tool("edit", { path: "src/b.ts" }, { status: "running" }),
  ]),
  assistant("m3", [tool("write", { path: "src/c.md" }, { diff: "+only diff" })]),
]

describe("replaySteps", () => {
  test("collects completed edit/write/patch calls in message order", () => {
    const steps = replaySteps(FIXTURE)
    expect(steps.map((step) => [step.tool, step.filePath])).toEqual([
      ["edit", "src/a.ts"],
      ["write", "src/c.md"],
    ])
  })

  test("patch falls back from metadata.files[0].patch to metadata.diff", () => {
    const steps = replaySteps(FIXTURE)
    expect(steps[0]?.patch).toBe("+fixed\n-old")
    expect(steps[1]?.patch).toBe("+only diff")
  })

  test("step indices are 1-based and sequential", () => {
    expect(replaySteps(FIXTURE).map((step) => step.index)).toEqual([1, 2])
  })

  test("empty input yields empty steps", () => {
    expect(replaySteps([])).toEqual([])
  })

  test("a completed edit without a payload still becomes a step", () => {
    const steps = replaySteps([assistant("m1", [tool("edit", { path: "src/d.ts" })])])
    expect(steps).toHaveLength(1)
    expect(steps[0]?.patch).toBeUndefined()
  })

  test("apply_patch is canonicalized to patch and file_path is accepted", () => {
    const steps = replaySteps([
      assistant("m1", [tool("apply_patch", { file_path: "src/e.ts" }, { files: [{ patch: "+x" }] })]),
    ])
    expect(steps[0]?.tool).toBe("patch")
    expect(steps[0]?.filePath).toBe("src/e.ts")
  })

  test("write without a diff synthesizes a full-add hunk the diff renderer accepts", () => {
    const steps = replaySteps([assistant("m1", [tool("write", { path: "a.md", content: "# hi\n\nbody" })])])
    const lines = (steps[0]?.patch ?? "").split("\n")
    const header = lines[0]?.match(/^@@ -0,0 \+1,(\d+) @@$/)
    expect(header).not.toBeNull()
    expect(Number(header?.[1])).toBe(lines.length - 1)
    expect(lines.slice(1).every((line) => line.startsWith("+"))).toBe(true)
  })

  test("user, system and error parts are ignored", () => {
    const steps = replaySteps([
      { id: "m1", type: "user", text: "/edit a.ts", time: { created: CREATED } },
      assistant("m2", [tool("edit", { path: "src/f.ts" }, { status: "error" })]),
    ])
    expect(steps).toEqual([])
  })

  test("the step carries the message timestamp", () => {
    expect(replaySteps(FIXTURE)[0]?.time).toBe(CREATED)
  })
})

describe("sanitizeReplayText", () => {
  test("strips ANSI escapes and control characters, keeps newlines", () => {
    expect(sanitizeReplayText("\x1b[31mred\x1b[0m")).toBe("red")
    expect(sanitizeReplayText("ok\x07bell\x00null")).toBe("okbellnull")
    expect(sanitizeReplayText("keep\nnewlines")).toBe("keep\nnewlines")
  })

  test("step file paths and patches are sanitized", () => {
    const steps = replaySteps([
      assistant("m1", [tool("write", { path: "a\x1b[1m.ts" }, { files: [{ patch: "+\x1b[32mgreen" }] })]),
    ])
    expect(steps[0]?.filePath).toBe("a.ts")
    expect(steps[0]?.patch).toBe("+green")
  })
})

describe("clampReplayPatch", () => {
  test("truncates with a marker and passes short patches through", () => {
    expect(clampReplayPatch("+1\n+2\n+3", 2)).toBe("+1\n… (truncated)")
    expect(clampReplayPatch("+1", 2)).toBe("+1")
  })

  test("truncation keeps the patch parser-valid by rewriting the hunk counts", () => {
    const big = "@@ -0,0 +1,500 @@\n" + Array.from({ length: 500 }, (_, index) => `+line${index}`).join("\n")
    const lines = clampReplayPatch(big).split("\n")
    const header = lines[0]?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/)
    expect(header).not.toBeNull()
    const body = lines.slice(1)
    expect(body[body.length - 1]).toBe(" … (truncated)")
    expect(body.every((line) => /^[ +'\\-]/.test(line))).toBe(true)
    const oldCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
    const newCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
    expect(Number(header?.[2])).toBe(oldCount)
    expect(Number(header?.[4])).toBe(newCount)
  })

  test("truncation inside a later hunk rewrites only that hunk", () => {
    const first = ["@@ -1,2 +1,2 @@", " ctx", "-old", "+new"]
    const second = ["@@ -10,300 +10,300 @@", ...Array.from({ length: 300 }, (_, index) => `+s${index}`)]
    const lines = clampReplayPatch([...first, ...second].join("\n")).split("\n")
    expect(lines[0]).toBe("@@ -1,2 +1,2 @@")
    const header = lines[4]?.match(/^@@ -10,(\d+) \+10,(\d+) @@$/)
    expect(header).not.toBeNull()
    const body = lines.slice(5)
    expect(body[body.length - 1]).toBe(" … (truncated)")
    const oldCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
    const newCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
    expect(Number(header?.[1])).toBe(oldCount)
    expect(Number(header?.[2])).toBe(newCount)
  })

  test("clamps the width of a single long line so one line cannot flood the pane", () => {
    const long = "+" + "x".repeat(5000)
    const clamped = clampReplayPatch(long, 10, 100)
    const [first] = clamped.split("\n")
    expect(first?.length).toBe(101)
    expect(first?.startsWith("+")).toBe(true)
    expect(first?.endsWith("…")).toBe(true)
    expect(clamped.split("\n")).toHaveLength(1)
  })

  test("clamps long lines inside a hunk without breaking the hunk", () => {
    const patch = "@@ -0,0 +1,2 @@\n+" + "y".repeat(1000) + "\n+short"
    const lines = clampReplayPatch(patch, 10, 80).split("\n")
    expect(lines[0]).toBe("@@ -0,0 +1,2 @@")
    expect(lines[1]?.length).toBe(81)
    expect(lines[2]).toBe("+short")
  })
})

describe("compactReplayPatch", () => {
  test("keeps at most the requested context lines beside every change", () => {
    const body = [
      " a0", " a1", " a2", " a3", "-old", "+new", " b0", " b1", " b2", " b3",
    ]
    const patch = ["@@ -1,10 +1,10 @@", ...body].join("\n")
    const compacted = compactReplayPatch(patch, 1)
    expect(compacted.split("\n")).toEqual([
      "@@ -4,3 +4,3 @@",
      " a3",
      "-old",
      "+new",
      " b0",
    ])
  })

  test("passes hunks without changes through verbatim", () => {
    const patch = "@@ -1,2 +1,2 @@\n ctx\n ctx2"
    expect(compactReplayPatch(patch, 1)).toBe(patch)
  })

  test("keeps multiple hunks and recomputes each header", () => {
    const patch = [
      "@@ -1,6 +1,6 @@",
      " a", " b", " c", "-d", "+e", " f",
      "@@ -20,5 +20,5 @@",
      " g", " h", " i", "-j", "+k",
    ].join("\n")
    const lines = compactReplayPatch(patch, 1).split("\n")
    expect(lines.slice(0, 5)).toEqual(["@@ -3,3 +3,3 @@", " c", "-d", "+e", " f"])
    expect(lines[5]).toBe("@@ -22,2 +22,2 @@")
    expect(lines.slice(6)).toEqual([" i", "-j", "+k"])
  })
})

describe("labels", () => {
  test("replayTimeLabel renders a clock time or an empty string", () => {
    expect(replayTimeLabel(CREATED)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(replayTimeLabel(undefined)).toBe("")
  })

  test("replayFileName strips directories", () => {
    expect(replayFileName("/home/u/proj/src/deep/file.ts")).toBe("file.ts")
    expect(replayFileName("README.md")).toBe("README.md")
    expect(replayFileName("")).toBe("")
  })
})
