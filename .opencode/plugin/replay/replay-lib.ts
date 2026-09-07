import path from "node:path"

export type ReplayStep = {
  index: number
  messageID: string
  tool: string
  filePath: string
  patch: string | undefined
  time: number | undefined
}

export type TranscriptRow =
  | { kind: "user"; messageID: string; text: string }
  | { kind: "assistant"; messageID: string; text: string }
  | { kind: "tool"; messageID: string; tool: string; summary: string }

export type RawPart = {
  type: string
  text?: unknown
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: unknown
    metadata?: Record<string, unknown>
  }
}

export type RawMessage = {
  info: { id: string; role: string; time?: { created?: number } }
  parts: RawPart[]
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])

// Session content is untrusted: strip ANSI/OSC sequences and C0 control
// characters so nothing renders beyond plain text (opentui draws verbatim).
const CONTROL_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function sanitizeText(value: string): string {
  return value.replace(CONTROL_PATTERN, "")
}

export function clampPatchLines(patch: string, maxLines = 200): string {
  const lines = patch.split("\n")
  if (lines.length <= maxLines) return patch
  return lines.slice(0, maxLines).join("\n") + "\n… (truncated)"
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function stepPatch(part: RawPart): string | undefined {
  const metadata = part.state?.metadata ?? {}
  return stringValue(recordValue(metadata.filediff)?.patch) ?? stringValue(metadata.diff)
}

export function inputFilePath(part: RawPart): string {
  return stringValue(part.state?.input?.filePath) ?? stringValue(part.state?.input?.file_path) ?? ""
}

export function buildReplaySteps(messages: readonly RawMessage[]): ReplayStep[] {
  const steps: ReplayStep[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      if (!EDIT_TOOLS.has(part.tool)) continue
      if (part.state?.status !== "completed") continue
      steps.push({
        index: steps.length + 1,
        messageID: message.info.id,
        tool: part.tool,
        filePath: sanitizeText(inputFilePath(part)),
        patch: sanitizePatch(stepPatch(part)),
        time: message.info.time?.created,
      })
    }
  }
  return steps
}

function sanitizePatch(patch: string | undefined): string | undefined {
  return patch === undefined ? undefined : sanitizeText(patch)
}

export function buildTranscriptRows(messages: readonly RawMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      const text = stringValue(part.text)
      if (part.type === "text" && text !== undefined) {
        rows.push({
          kind: message.info.role === "user" ? "user" : "assistant",
          messageID: message.info.id,
          text: sanitizeText(text),
        })
        continue
      }
      if (part.type === "tool" && part.tool) {
        if (isStepPart(part)) continue
        rows.push({ kind: "tool", messageID: message.info.id, tool: part.tool, summary: sanitizeText(inputFilePath(part)) })
      }
    }
  }
  return rows
}

// Completed edit-tool parts with the canonical filediff payload are rendered
// as replay steps in the left pane; keep the transcript free of duplicates.
// Parts with only a legacy metadata.diff still appear as transcript rows.
function isStepPart(part: RawPart): boolean {
  if (!EDIT_TOOLS.has(part.tool!)) return false
  if (part.state?.status !== "completed") return false
  const metadata = part.state?.metadata ?? {}
  return stringValue(recordValue(metadata.filediff)?.patch) !== undefined
}

export function timeLabel(time: number | undefined): string {
  if (time === undefined) return ""
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const REPLAY_PANE_WIDTH_DEFAULT = 36
export const REPLAY_PANE_WIDTH_MIN = 24
export const REPLAY_PANE_WIDTH_MAX = 60

export function clampReplayPaneWidth(value: number): number {
  const width = Math.round(Number(value))
  if (!Number.isFinite(width)) return REPLAY_PANE_WIDTH_DEFAULT
  return Math.min(REPLAY_PANE_WIDTH_MAX, Math.max(REPLAY_PANE_WIDTH_MIN, width))
}

// kv.json is user-writable state, so every read re-validates instead of
// trusting stored shapes.
export function parseReplayPaneWidth(value: unknown): number {
  if (typeof value === "number") return clampReplayPaneWidth(value)
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return clampReplayPaneWidth(parsed)
  }
  return REPLAY_PANE_WIDTH_DEFAULT
}

// Port of packages/tui/src/util/filetype.ts so the <diff> preview gets the
// same language mapping as the /diff viewer; unmapped extensions render
// unhighlighted, exactly as there.
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".abap": "abap",
  ".bat": "bat",
  ".bib": "bibtex",
  ".bibtex": "bibtex",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".coffee": "coffeescript",
  ".c": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".cs": "csharp",
  ".csx": "csharp",
  ".css": "css",
  ".d": "d",
  ".pas": "pascal",
  ".pascal": "pascal",
  ".diff": "diff",
  ".patch": "diff",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".ets": "typescript",
  ".hrl": "erlang",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".gitcommit": "git-commit",
  ".gitrebase": "git-rebase",
  ".go": "go",
  ".groovy": "groovy",
  ".gleam": "gleam",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".tex": "latex",
  ".latex": "latex",
  ".less": "less",
  ".lua": "lua",
  ".makefile": "makefile",
  makefile: "makefile",
  ".md": "markdown",
  ".markdown": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".pl": "perl",
  ".pm": "perl",
  ".pm6": "perl6",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".pug": "jade",
  ".jade": "jade",
  ".py": "python",
  ".r": "r",
  ".cshtml": "razor",
  ".razor": "razor",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".erb": "erb",
  ".html.erb": "erb",
  ".js.erb": "erb",
  ".css.erb": "erb",
  ".json.erb": "erb",
  ".rs": "rust",
  ".scss": "scss",
  ".sass": "sass",
  ".scala": "scala",
  ".shader": "shaderlab",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".xml": "xml",
  ".xsl": "xsl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".zig": "zig",
  ".zon": "zig",
  ".astro": "astro",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".nix": "nix",
  ".typ": "typst",
  ".typc": "typst",
}

export function filetypeFromPath(input?: string): string | undefined {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

// Mouse-drag on the pane's left border: moving the border left (negative
// mouse delta) widens the pane, mirroring GUI splitters.
export function replayPaneDragWidth(startWidth: number, startX: number, currentX: number): number {
  return clampReplayPaneWidth(startWidth + startX - currentX)
}

// Invisible grip zone (columns) around the splitter's visible border line.
export const REPLAY_SPLITTER_HIT_WIDTH = 4

export type SplitterFeedback = "idle" | "hover" | "drag"

// Drag beats hover: opentui suppresses out-events on a captured renderable,
// so the active look must be driven by the drag flag, not the cursor.
export function splitterFeedback(hover: boolean, dragging: boolean): SplitterFeedback {
  if (dragging) return "drag"
  if (hover) return "hover"
  return "idle"
}

// Columns of horizontal movement before a press counts as a drag, not a click.
export const REPLAY_DRAG_THRESHOLD = 2

// GUI-convention splitter: a press that stays within the threshold is a click
// (forwarded to the pane content), larger movement is a resize drag.
export function isDragIntent(startX: number, currentX: number, threshold = REPLAY_DRAG_THRESHOLD): boolean {
  return Math.abs(currentX - startX) >= threshold
}

export type ReplayDragTracker = {
  move: (x: number) => void
  readonly moved: boolean
  readonly width: number
}

// Incremental drag tracking: every move contributes its signed delta, so the
// width stays correct even while the pane resize shifts the strip under the
// cursor. Motion past REPLAY_DRAG_THRESHOLD from the press point latches the
// gesture into a drag.
export function createDragTracker(startWidth: number, startX: number): ReplayDragTracker {
  let prevX = startX
  let width = clampReplayPaneWidth(startWidth)
  let moved = false
  return {
    move(x: number) {
      moved = moved || isDragIntent(startX, x)
      width = clampReplayPaneWidth(width + (prevX - x))
      prevX = x
    },
    get moved() {
      return moved
    },
    get width() {
      return width
    },
  }
}

export type StepHitTestEntry = { index: number; screenY: number; height: number }

// Resolves the step card under a grip click. screenY values are opaque to the
// hit test — they come from the renderable and already include its scroll
// translation. Lower bound inclusive, upper exclusive; later cards win ties.
export function stepIndexAtY(boxes: StepHitTestEntry[], clickY: number): number | null {
  if (!Number.isFinite(clickY)) return null
  let hit: number | null = null
  for (const box of [...boxes].sort((a, b) => a.screenY - b.screenY)) {
    if (clickY < box.screenY || clickY >= box.screenY + box.height) continue
    hit = box.index
  }
  return hit
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// Unified-diff-aware context trimming: keeps at most `context` lines beside
// every change (git -U semantics). Trimmed hunks get their @@ headers
// recomputed so old/new numbering stays truthful for the <diff> renderer;
// hunks without changes or already within budget pass through verbatim.
export function compactPatch(patch: string, context = 2): string {
  const lines = patch.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]?.match(HUNK_HEADER)
    if (!header) {
      out.push(lines[i] ?? "")
      i++
      continue
    }
    let end = i + 1
    while (end < lines.length && !HUNK_HEADER.test(lines[end] ?? "")) end++
    const body = lines.slice(i + 1, end)
    out.push(...compactHunk(lines[i] ?? "", header, body, context))
    i = end
  }
  return out.join("\n")
}

function compactHunk(headerLine: string, header: RegExpMatchArray, body: string[], context: number): string[] {
  // "" (split artifact of a trailing newline) and "\ No newline" markers count
  // as neither change nor context for anchoring purposes.
  const isChange = (line: string) => line !== "" && !line.startsWith(" ") && !line.startsWith("\\")
  const changeIndices = body.flatMap((line, k) => (isChange(line) ? [k] : []))
  const kept = new Array<boolean>(body.length).fill(false)
  for (const change of changeIndices) {
    for (let k = Math.max(0, change - context); k <= Math.min(body.length - 1, change + context); k++) {
      kept[k] = true
    }
  }

  const oldInc = body.map((line) => (line.startsWith(" ") || line.startsWith("-") ? 1 : 0))
  const newInc = body.map((line) => (line.startsWith(" ") || line.startsWith("+") ? 1 : 0))
  const prefixOld = runningSum(oldInc)
  const prefixNew = runningSum(newInc)
  const oldStart = Number(header[1])
  const newStart = Number(header[3])
  if (context < 0 || changeIndices.length === 0 || kept.every(Boolean)) {
    return [headerLine, ...body]
  }

  const result: string[] = []
  let k = 0
  while (k < kept.length) {
    if (!kept[k]) {
      k++
      continue
    }
    let runEnd = k
    while (runEnd + 1 < kept.length && kept[runEnd + 1]) runEnd++
    const runOld = oldStart + (prefixOld[k] ?? 0)
    const runNew = newStart + (prefixNew[k] ?? 0)
    const countOld = (prefixOld[runEnd + 1] ?? 0) - (prefixOld[k] ?? 0)
    const countNew = (prefixNew[runEnd + 1] ?? 0) - (prefixNew[k] ?? 0)
    result.push(`@@ -${runOld},${countOld} +${runNew},${countNew} @@`)
    for (let m = k; m <= runEnd; m++) result.push(body[m] ?? "")
    k = runEnd + 1
  }
  return result
}

function runningSum(inc: number[]): number[] {
  const sums = [0]
  for (const value of inc) sums.push((sums[sums.length - 1] ?? 0) + value)
  return sums
}
