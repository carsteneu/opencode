import { describe, expect, test } from "bun:test"
import {
  buildReplaySteps,
  buildTranscriptRows,
  clampPatchLines,
  clampReplayPaneWidth,
  compactPatch,
  createDragTracker,
  dateLabel,
  fileBaseName,
  filetypeFromPath,
  isDragIntent,
  parseReplayPaneWidth,
  REPLAY_SPLITTER_HIT_WIDTH,
  sanitizeText,
  shouldSyncScroll,
  splitterFeedback,
  stepIndexAtY,
  timeLabel,
  topStepIndexAtY,
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

  test("write without filediff synthesizes a real full-add hunk the diff renderer accepts", () => {
    const message = msg("m1", "assistant", [
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "a.md", content: "# hi\n\nbody" } } },
    ])
    const steps = buildReplaySteps([message])
    const patch = steps[0]?.patch ?? ""
    const lines = patch.split("\n")
    const header = lines[0]?.match(/^@@ -0,0 \+1,(\d+) @@$/)
    expect(header).not.toBeNull()
    const declared = Number(header?.[1])
    expect(declared).toBe(lines.length - 1)
    expect(lines.slice(1).every((l) => l.startsWith("+"))).toBe(true)
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

describe("dateLabel", () => {
  test("renders a dd.mm. date or an empty string when missing", () => {
    expect(dateLabel(1700000000000)).toMatch(/^\d{2}\.\d{2}\.$/)
    expect(dateLabel(undefined)).toBe("")
  })
})

describe("fileBaseName", () => {
  test("strips directories from a path", () => {
    expect(fileBaseName("/home/u/proj/src/deep/file.ts")).toBe("file.ts")
    expect(fileBaseName("README.md")).toBe("README.md")
    expect(fileBaseName("")).toBe("")
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
    expect(clamped).toBe("+1\n… (truncated)")
    expect(clampPatchLines("+1", 2)).toBe("+1")
  })

  test("clampPatchLines truncation keeps the patch parser-valid (notice is a context line, counts rewritten)", () => {
    const big = "@@ -0,0 +1,500 @@\n" + Array.from({ length: 500 }, (_, i) => `+line${i}`).join("\n")
    const out = clampPatchLines(big)
    const lines = out.split("\n")
    const header = lines[0]?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/)
    expect(header).not.toBeNull()
    const body = lines.slice(1)
    expect(body[body.length - 1]).toBe(" … (truncated)")
    expect(body.every((l) => /^[ +'\\-]/.test(l))).toBe(true)
    const oldCount = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length
    const newCount = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length
    expect(Number(header?.[2])).toBe(oldCount)
    expect(Number(header?.[4])).toBe(newCount)
  })

  test("clampPatchLines truncation inside the second hunk rewrites only that hunk", () => {
    const first = ["@@ -1,2 +1,2 @@", " ctx", "-old", "+new"]
    const second = ["@@ -10,300 +10,300 @@", ...Array.from({ length: 300 }, (_, i) => `+s${i}`)]
    const out = clampPatchLines([...first, ...second].join("\n"))
    const lines = out.split("\n")
    expect(lines[0]).toBe("@@ -1,2 +1,2 @@")
    const secondHeader = lines[4]?.match(/^@@ -10,(\d+) \+10,(\d+) @@$/)
    expect(secondHeader).not.toBeNull()
    const body = lines.slice(5)
    expect(body[body.length - 1]).toBe(" … (truncated)")
    const oldCount = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length
    const newCount = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length
    expect(Number(secondHeader?.[1])).toBe(oldCount)
    expect(Number(secondHeader?.[2])).toBe(newCount)
  })

  test("clampPatchLines truncation inside the preamble appends a bare notice", () => {
    const big = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1,500 @@", ...Array.from({ length: 500 }, (_, i) => `+l${i}`)].join("\n")
    const out = clampPatchLines(big, 3)
    expect(out).toBe("diff --git a/f b/f\n--- a/f\n… (truncated)")
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
      expect(parseReplayPaneWidth(100)).toBe(100)
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
  test("rounds and keeps the 24 floor", () => {
    expect(clampReplayPaneWidth(30.2)).toBe(30)
    expect(clampReplayPaneWidth(Number.NaN)).toBe(36)
    expect(clampReplayPaneWidth(100)).toBe(100)
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

describe("compactPatch", () => {
  const patch = [
    "--- a/demo.md",
    "+++ b/demo.md",
    "@@ -1,9 +1,9 @@",
    " one",
    " two",
    " three",
    " four",
    " five",
    "-old",
    "+new",
    " six",
    " seven",
    " eight",
  ].join("\n")

  test("trims edge context to the budget and recomputes hunk header counts", () => {
    expect(compactPatch(patch, 2)).toBe(
      [
        "--- a/demo.md",
        "+++ b/demo.md",
        "@@ -4,5 +4,5 @@",
        " four",
        " five",
        "-old",
        "+new",
        " six",
        " seven",
      ].join("\n"),
    )
  })

  test("hunks within the context budget are returned unchanged", () => {
    const small = ["--- a/f", "+++ b/f", "@@ -1,5 +1,5 @@", " a", " b", "-c", "+d", " e"].join("\n")
    expect(compactPatch(small, 2)).toBe(small)
  })

  test("patches without hunk headers are returned unchanged", () => {
    expect(compactPatch("+fixed\n-old")).toBe("+fixed\n-old")
  })

  test("multiple hunks are compacted independently", () => {
    const two = [
      "--- a/m",
      "+++ b/m",
      "@@ -1,8 +1,8 @@",
      " c1",
      " c2",
      " c3",
      " c4",
      "-c5",
      "+c6",
      " c7",
      " c8",
      "@@ -10,3 +10,3 @@",
      " c9",
      "-x10",
      "+x11",
      " c12",
    ].join("\n")
    expect(compactPatch(two, 2)).toBe(
      [
        "--- a/m",
        "+++ b/m",
        "@@ -3,5 +3,5 @@",
        " c3",
        " c4",
        "-c5",
        "+c6",
        " c7",
        " c8",
        "@@ -10,3 +10,3 @@",
        " c9",
        "-x10",
        "+x11",
        " c12",
      ].join("\n"),
    )
  })

  test("interior context beyond the budget splits hunks with recomputed headers", () => {
    const interior = "@@ -1,9 +1,9 @@\n a\n-b\n+c\n d\n e\n f\n g\n h\n-i\n+j\n k"
    expect(compactPatch(interior, 2)).toBe(
      "@@ -1,4 +1,4 @@\n a\n-b\n+c\n d\n e\n@@ -6,4 +6,4 @@\n g\n h\n-i\n+j\n k",
    )
  })

  test("tolerates hunk headers without line counts", () => {
    const uncounted = "@@ -3 +3 @@\n a\n b\n-old\n+new\n c\n d"
    expect(compactPatch(uncounted, 1)).toBe("@@ -4,3 +4,3 @@\n b\n-old\n+new\n c")
  })

  test("no-newline markers and empty lines are not change anchors", () => {
    const patch = "@@ -1,4 +1,4 @@\n-a\n+b\n\\ No newline at end of file\n ctx1\n ctx2\n ctx3\n ctx4\n+end"
    expect(compactPatch(patch, 2)).toBe(
      "@@ -1,2 +1,2 @@\n-a\n+b\n\\ No newline at end of file\n ctx1\n@@ -4,2 +4,3 @@\n ctx3\n ctx4\n+end",
    )
  })
})

describe("REPLAY_SPLITTER_HIT_WIDTH", () => {
  test("pins the grip zone at 4 columns", () => {
    expect(REPLAY_SPLITTER_HIT_WIDTH).toBe(4)
  })
})

describe("splitterFeedback", () => {
  test("idle when neither hovered nor dragged", () => {
    expect(splitterFeedback(false, false)).toBe("idle")
  })

  test("hover when only hovered", () => {
    expect(splitterFeedback(true, false)).toBe("hover")
  })

  test("drag wins over hover", () => {
    expect(splitterFeedback(false, true)).toBe("drag")
    expect(splitterFeedback(true, true)).toBe("drag")
  })
})

describe("isDragIntent", () => {
  test("movement below the threshold is a click", () => {
    expect(isDragIntent(40, 41)).toBe(false)
    expect(isDragIntent(40, 39)).toBe(false)
  })

  test("movement at the threshold is a drag", () => {
    expect(isDragIntent(40, 42)).toBe(true)
    expect(isDragIntent(40, 38)).toBe(true)
  })

  test("no movement is a click", () => {
    expect(isDragIntent(40, 40)).toBe(false)
  })

  test("custom threshold", () => {
    expect(isDragIntent(40, 43, 3)).toBe(true)
    expect(isDragIntent(40, 42, 3)).toBe(false)
  })
})

describe("createDragTracker", () => {
  test("starts as a click at the start width", () => {
    const tracker = createDragTracker(36, 40)
    expect(tracker.moved).toBe(false)
    expect(tracker.width).toBe(36)
  })

  test("a single leftward motion past the threshold widens the pane", () => {
    const tracker = createDragTracker(36, 40)
    tracker.move(27)
    expect(tracker.moved).toBe(true)
    expect(tracker.width).toBe(49)
  })

  test("accumulates incremental deltas regardless of element shifts", () => {
    const tracker = createDragTracker(36, 40)
    tracker.move(37)
    tracker.move(35)
    tracker.move(34)
    expect(tracker.moved).toBe(true)
    expect(tracker.width).toBe(42)
  })

  test("rightward motion narrows the pane", () => {
    const tracker = createDragTracker(36, 40)
    tracker.move(43)
    expect(tracker.width).toBe(33)
  })

  test("clamps at the 24 floor on every move", () => {
    const tracker = createDragTracker(58, 10)
    tracker.move(1)
    expect(tracker.width).toBe(67)
    tracker.move(99)
    expect(tracker.width).toBe(24)
  })

  test("stays a click while movement is below the threshold", () => {
    const tracker = createDragTracker(36, 40)
    tracker.move(41)
    expect(tracker.moved).toBe(false)
    expect(tracker.width).toBe(35)
  })

  test("once the threshold trips, the latch holds on net-zero jitters", () => {
    const tracker = createDragTracker(36, 40)
    tracker.move(38)
    tracker.move(40)
    expect(tracker.moved).toBe(true)
    expect(tracker.width).toBe(36)
  })
})

describe("stepIndexAtY", () => {
  const boxes = [
    { index: 1, screenY: 10, height: 5 },
    { index: 2, screenY: 15, height: 3 },
    { index: 3, screenY: 20, height: 4 },
  ]

  test("click inside a box selects that step", () => {
    expect(stepIndexAtY(boxes, 10)).toBe(1)
    expect(stepIndexAtY(boxes, 14)).toBe(1)
    expect(stepIndexAtY(boxes, 15)).toBe(2)
    expect(stepIndexAtY(boxes, 17)).toBe(2)
    expect(stepIndexAtY(boxes, 20)).toBe(3)
    expect(stepIndexAtY(boxes, 23)).toBe(3)
  })

  test("click in the gap between boxes is no hit", () => {
    expect(stepIndexAtY(boxes, 18)).toBe(null)
    expect(stepIndexAtY(boxes, 19)).toBe(null)
  })

  test("click outside all boxes is no hit", () => {
    expect(stepIndexAtY(boxes, 9)).toBe(null)
    expect(stepIndexAtY(boxes, 24)).toBe(null)
  })

  test("no boxes means no hit", () => {
    expect(stepIndexAtY([], 10)).toBe(null)
  })

  test("boxes given out of order still resolve by position", () => {
    const shuffled = [boxes[2], boxes[0], boxes[1]]
    expect(stepIndexAtY(shuffled, 16)).toBe(2)
  })

  test("overlapping boxes: the later card wins the tie", () => {
    const overlapping = [
      { index: 1, screenY: 10, height: 10 },
      { index: 2, screenY: 15, height: 5 },
    ]
    expect(stepIndexAtY(overlapping, 16)).toBe(2)
  })

  test("non-finite click coordinates never hit", () => {
    expect(stepIndexAtY(boxes, Number.NaN)).toBe(null)
    expect(stepIndexAtY(boxes, Number.POSITIVE_INFINITY)).toBe(null)
  })
})

describe("topStepIndexAtY", () => {
  const cards = [
    { index: 0, y: 0, height: 10 },
    { index: 1, y: 12, height: 10 },
    { index: 2, y: 30, height: 10 },
  ]

  test("pick the first card intersecting the viewport", () => {
    expect(topStepIndexAtY(cards, 0, 20)).toBe(0)
    expect(topStepIndexAtY(cards, 12, 10)).toBe(1)
  })

  test("cards partially visible at the top edge win", () => {
    expect(topStepIndexAtY(cards, 8, 6)).toBe(0)
    expect(topStepIndexAtY(cards, 20, 12)).toBe(1)
  })

  test("scroll position past every card is no hit", () => {
    expect(topStepIndexAtY(cards, 41, 10)).toBe(null)
  })

  test("degenerate inputs are no hit", () => {
    expect(topStepIndexAtY(cards, Number.NaN, 10)).toBe(null)
    expect(topStepIndexAtY(cards, 0, 0)).toBe(null)
    expect(topStepIndexAtY([], 0, 10)).toBe(null)
  })
})

describe("shouldSyncScroll", () => {
  const base = { now: 1000, suppressUntil: 1100, messageID: "msg_1", lastMessageID: "msg_0" }

  test("suppressed within the settling window", () => {
    expect(shouldSyncScroll({ ...base, now: 1099 })).toBe(false)
  })

  test("fires after the suppression window", () => {
    expect(shouldSyncScroll({ ...base, now: 1100 })).toBe(true)
  })

  test("same anchor message needs no sync", () => {
    expect(shouldSyncScroll({ ...base, now: 1200, lastMessageID: "msg_1" })).toBe(false)
  })

  test("unknown anchor message never syncs", () => {
    expect(shouldSyncScroll({ ...base, now: 1200, messageID: undefined })).toBe(false)
  })
})
