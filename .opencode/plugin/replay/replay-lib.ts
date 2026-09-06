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
