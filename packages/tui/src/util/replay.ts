import path from "node:path"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { canonicalToolName, toolDisplayMetadata } from "./tool-display"

export type ReplayStep = {
  readonly index: number
  readonly tool: string
  readonly filePath: string
  readonly patch: string | undefined
  readonly time: number | undefined
}

// v2 renamed apply_patch to patch; canonicalToolName maps the pre-rename name too.
const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const CONTROL_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const TRUNCATED = "… (truncated)"

export const REPLAY_PATCH_MAX_LINES = 200
export const REPLAY_PATCH_MAX_LINE_WIDTH = 400

type ToolPart = Extract<SessionMessageAssistant["content"][number], { type: "tool" }>

// Session content is untrusted: strip ANSI/OSC sequences and C0 control
// characters so nothing renders beyond plain text.
export function sanitizeReplayText(value: string): string {
  return value.replace(CONTROL_PATTERN, "")
}

/** Completed edit/write/patch calls of a session, oldest first. */
export function replaySteps(messages: readonly SessionMessageInfo[]): ReplayStep[] {
  const steps: ReplayStep[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      const tool = canonicalToolName(part.name)
      if (!EDIT_TOOLS.has(tool)) continue
      if (part.state.status !== "completed") continue
      steps.push({
        index: steps.length + 1,
        tool,
        filePath: sanitizeReplayText(inputPath(part.state.input)),
        patch: sanitizePatch(stepPatch(part.state)),
        time: message.time.created,
      })
    }
  }
  return steps
}

function inputPath(input: Record<string, unknown>): string {
  return stringValue(input.path) ?? stringValue(input.filePath) ?? stringValue(input.file_path) ?? ""
}

// A single line the width of a screen's worth of megabytes would be drawn
// verbatim by the renderer, so bound per-line width as well as line count.
export function clampReplayPatch(
  patch: string,
  maxLines = REPLAY_PATCH_MAX_LINES,
  maxLineWidth = REPLAY_PATCH_MAX_LINE_WIDTH,
): string {
  return clampLines(clampLineWidths(patch, maxLineWidth), maxLines)
}

/** Unified-diff-aware context trimming: git -U semantics, headers recomputed. */
export function compactReplayPatch(patch: string, context = 2): string {
  const lines = patch.split("\n")
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const header = (lines[index] ?? "").match(HUNK_HEADER)
    if (!header) {
      out.push(lines[index] ?? "")
      index++
      continue
    }
    let end = index + 1
    while (end < lines.length && !HUNK_HEADER.test(lines[end] ?? "")) end++
    out.push(...compactHunk(lines[index] ?? "", header, lines.slice(index + 1, end), context))
    index = end
  }
  return out.join("\n")
}

export function replayTimeLabel(time: number | undefined): string {
  if (time === undefined) return ""
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function replayFileName(filePath: string): string {
  if (filePath === "") return ""
  return path.basename(filePath)
}

function inputValue(state: ToolPart["state"]): Record<string, unknown> {
  return state.input
}

function stepPatch(state: ToolPart["state"]): string | undefined {
  const metadata = toolDisplayMetadata(state)
  const files = metadata.files
  if (Array.isArray(files)) {
    for (const entry of files) {
      const patch = stringValue(recordValue(entry)?.patch)
      if (patch !== undefined) return patch
    }
  }
  const diff = stringValue(metadata.diff)
  if (diff !== undefined) return diff
  // File-creation: the write tool stores no diff, but the whole content is in
  // the input — synthesize a full-add patch. The hunk header is required: the
  // diff renderer yields no hunks without it and draws nothing.
  const content = stringValue(inputValue(state).content)
  if (content === undefined) return
  const lines = content.split("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}`
}

function sanitizePatch(patch: string | undefined): string | undefined {
  return patch === undefined ? undefined : sanitizeReplayText(patch)
}

function clampLineWidths(patch: string, maxLineWidth: number): string {
  if (maxLineWidth <= 0) return patch
  return patch
    .split("\n")
    .map((line) => (line.length > maxLineWidth ? line.slice(0, maxLineWidth) + "…" : line))
    .join("\n")
}

function clampLines(patch: string, maxLines: number): string {
  const lines = patch.split("\n")
  if (lines.length <= maxLines) return patch

  let hunk = -1
  for (let index = Math.min(maxLines - 1, lines.length - 1); index >= 0; index--) {
    if (HUNK_HEADER.test(lines[index] ?? "")) {
      hunk = index
      break
    }
  }

  const kept = lines.slice(0, maxLines - 1)
  if (hunk === -1) return [...kept, TRUNCATED].join("\n")

  // The cut may land inside a hunk body: the diff parser validates hunk line
  // counts strictly, so rewrite them and keep the notice as a context line.
  const header = (lines[hunk] ?? "").match(HUNK_HEADER)!
  const body = lines.slice(hunk + 1, maxLines - 1)
  const oldKept = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
  const newKept = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
  const oldDeclared = Number(header[2] ?? 1)
  const newDeclared = Number(header[4] ?? 1)
  if (oldKept === oldDeclared && newKept === newDeclared) return [...kept, TRUNCATED].join("\n")

  const truncated = [
    `@@ -${header[1]},${oldKept + 1} +${header[3]},${newKept + 1} @@`,
    ...body,
    " " + TRUNCATED,
  ]
  return [...lines.slice(0, hunk), ...truncated].join("\n")
}

function compactHunk(headerLine: string, header: RegExpMatchArray, body: string[], context: number): string[] {
  // "" (split artifact of a trailing newline) and "\ No newline" markers count
  // as neither change nor context.
  const isChange = (line: string) => line !== "" && !line.startsWith(" ") && !line.startsWith("\\")
  const changes = body.flatMap((line, index) => (isChange(line) ? [index] : []))
  const kept = new Array<boolean>(body.length).fill(false)
  for (const change of changes) {
    for (let index = Math.max(0, change - context); index <= Math.min(body.length - 1, change + context); index++) {
      kept[index] = true
    }
  }
  if (context < 0 || changes.length === 0 || kept.every(Boolean)) return [headerLine, ...body]

  const oldIncrement = body.map((line) => (line.startsWith(" ") || line.startsWith("-") ? 1 : 0))
  const newIncrement = body.map((line) => (line.startsWith(" ") || line.startsWith("+") ? 1 : 0))
  const oldPrefix = runningSum(oldIncrement)
  const newPrefix = runningSum(newIncrement)
  const oldStart = Number(header[1])
  const newStart = Number(header[3])

  const result: string[] = []
  let index = 0
  while (index < kept.length) {
    if (!kept[index]) {
      index++
      continue
    }
    let runEnd = index
    while (runEnd + 1 < kept.length && kept[runEnd + 1]) runEnd++
    const runOld = oldStart + (oldPrefix[index] ?? 0)
    const runNew = newStart + (newPrefix[index] ?? 0)
    const countOld = (oldPrefix[runEnd + 1] ?? 0) - (oldPrefix[index] ?? 0)
    const countNew = (newPrefix[runEnd + 1] ?? 0) - (newPrefix[index] ?? 0)
    result.push(`@@ -${runOld},${countOld} +${runNew},${countNew} @@`)
    for (let line = index; line <= runEnd; line++) result.push(body[line] ?? "")
    index = runEnd + 1
  }
  return result
}

function runningSum(increments: number[]): number[] {
  const sums = [0]
  for (const increment of increments) sums.push((sums[sums.length - 1] ?? 0) + increment)
  return sums
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
