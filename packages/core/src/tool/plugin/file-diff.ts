import { FileDiff } from "@opencode/schema/file-diff"
import { formatPatch, structuredPatch } from "diff"
import { emptyPatch } from "../../vcs/patch.js"

// Bounds ported from v1 (packages/core/src/text-diff.ts): diff@8 allocates its
// line-token arrays before honoring the timeout, so oversized inputs are
// rejected up front instead of blocking the runtime.
const DIFF_TIMEOUT_MS = 250
const MAX_DIFF_INPUT_CODE_UNITS = 4 * 1024 * 1024
const MAX_DIFF_LINE_TOKENS = 128 * 1024

export function fileDiff(
  file: string,
  before: string,
  after: string,
  status: typeof FileDiff.Info.Type.status = "modified",
): typeof FileDiff.Info.Type {
  const oldLines = countLines(before)
  const newLines = countLines(after)
  if (before.length + after.length > MAX_DIFF_INPUT_CODE_UNITS || oldLines + newLines > MAX_DIFF_LINE_TOKENS)
    return coarse(file, before, after, status, oldLines, newLines)

  const structured = structuredPatch(file, file, before, after, undefined, undefined, { timeout: DIFF_TIMEOUT_MS })
  if (!structured) return coarse(file, before, after, status, oldLines, newLines)

  const counts = countChanges(structured)
  return { file, patch: formatPatch(structured), status, ...counts }
}

// v1 kept an oversized patch out of FileDiff.Info, but its `patch` was optional
// and consumers fell back to the file contents. v2's `patch` is required and
// consumers apply it (packages/cli/src/acp/permission.ts), so an empty
// placeholder would show an oversized edit as no change. The input budget above
// is what keeps the result bounded; `patch` stays a real patch.
function coarse(
  file: string,
  before: string,
  after: string,
  status: typeof FileDiff.Info.Type.status,
  oldLines: number,
  newLines: number,
): typeof FileDiff.Info.Type {
  return {
    file,
    patch: emptyPatch(file),
    status,
    additions: before === after ? 0 : newLines,
    deletions: before === after ? 0 : oldLines,
  }
}

function countLines(value: string) {
  if (value === "") return 0
  let lines = value.endsWith("\n") ? 0 : 1
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) lines++
  return lines
}

function countChanges(patch: ReturnType<typeof structuredPatch>) {
  let additions = 0
  let deletions = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++
      if (line.startsWith("-")) deletions++
    }
  }
  return { additions, deletions }
}
