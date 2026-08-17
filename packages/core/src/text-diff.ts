export * as TextDiff from "./text-diff"

import { formatPatch, structuredPatch, type StructuredPatch } from "diff"
import { JsonString } from "./util/json-string"

const DEFAULT_TIMEOUT = 250
// diff@8 allocates line-token arrays before honoring timeout or edit-length limits.
const MAX_BOUNDED_INPUT_CODE_UNITS = 4 * 1024 * 1024
const MAX_BOUNDED_LINE_TOKENS = 128 * 1024

export interface Info {
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly coarse: boolean
}

export interface BoundedInfo {
  readonly patch?: string
  /** Exact JSON-string bytes when patch is present; otherwise maxSerializedPatchBytes + 1. */
  readonly serializedBytes: number
  readonly additions: number
  readonly deletions: number
}

/** Build a unified line patch and its statistics without allowing pathological diffs to block the runtime. */
export function create(
  oldFile: string,
  newFile: string,
  before: string,
  after: string,
  options?: { readonly timeout?: number; readonly maxEditLength?: number },
): Info {
  const structured = structuredPatch(oldFile, newFile, before, after, undefined, undefined, {
    timeout: options?.timeout ?? DEFAULT_TIMEOUT,
    ...(options?.maxEditLength === undefined ? {} : { maxEditLength: options.maxEditLength }),
  })
  if (!structured) return coarse(oldFile, newFile, before, after)

  let additions = 0
  let deletions = 0
  for (const hunk of structured.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++
      if (line.startsWith("-")) deletions++
    }
  }
  return { patch: formatPatch(structured), additions, deletions, coarse: false }
}

/** Build a patch within serialized-output and fixed diff-work budgets, falling back to coarse statistics. */
export function createBounded(
  oldFile: string,
  newFile: string,
  before: string,
  after: string,
  options: {
    readonly maxSerializedPatchBytes: number
    readonly timeout?: number
    readonly maxEditLength?: number
  },
): BoundedInfo {
  if (!Number.isSafeInteger(options.maxSerializedPatchBytes) || options.maxSerializedPatchBytes < 0)
    throw new RangeError("maxSerializedPatchBytes must be a non-negative safe integer")

  const maximum = options.maxSerializedPatchBytes
  if (before === after) {
    const serializedBytes = headerBytes(oldFile, newFile, maximum)
    if (serializedBytes > maximum) return { serializedBytes, additions: 0, deletions: 0 }
    return {
      patch: formatPatch({
        oldFileName: oldFile,
        newFileName: newFile,
        oldHeader: undefined,
        newHeader: undefined,
        hunks: [],
      }),
      serializedBytes,
      additions: 0,
      deletions: 0,
    }
  }

  if (
    (options.maxEditLength != null && (Number.isNaN(options.maxEditLength) || options.maxEditLength < 1)) ||
    (options.timeout != null && (Number.isNaN(options.timeout) || options.timeout <= 0))
  )
    return coarseBounded(oldFile, newFile, before, after, maximum)

  if (options.timeout === undefined && options.maxEditLength === undefined && singleLine(before) && singleLine(after)) {
    const additions = after === "" ? 0 : 1
    const deletions = before === "" ? 0 : 1
    const serializedBytes = simplePatchBytes(oldFile, newFile, before, after, maximum)
    if (serializedBytes > maximum) return { serializedBytes, additions, deletions }
  }

  const oldLines = countLines(before)
  const newLines = countLines(after)
  if (
    before.length + after.length > MAX_BOUNDED_INPUT_CODE_UNITS ||
    oldLines + newLines > MAX_BOUNDED_LINE_TOKENS ||
    headerBytes(oldFile, newFile, maximum) > maximum
  )
    return coarseBounded(oldFile, newFile, before, after, maximum, oldLines, newLines)

  const structured = structuredPatch(oldFile, newFile, before, after, undefined, undefined, {
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    ...(options.maxEditLength === undefined ? {} : { maxEditLength: options.maxEditLength }),
  })
  if (!structured) return coarseBounded(oldFile, newFile, before, after, maximum, oldLines, newLines)

  const changes = countChanges(structured)
  const serializedBytes = patchBytes(structured, maximum)
  if (serializedBytes > maximum) return { serializedBytes, ...changes }
  return { patch: formatPatch(structured), serializedBytes, ...changes }
}

function singleLine(value: string) {
  const newline = value.indexOf("\n")
  return newline === -1 || newline === value.length - 1
}

function simplePatchBytes(oldFile: string, newFile: string, before: string, after: string, maximum: number) {
  const result = JsonString.counter(maximum)
  writeHeader(result, oldFile, newFile)
  if (before !== after) {
    const oldLines = before === "" ? 0 : 1
    const newLines = after === "" ? 0 : 1
    result.write(`@@ -${oldLines === 0 ? 0 : 1},${oldLines} +${newLines === 0 ? 0 : 1},${newLines} @@\n`)
    writeSingleLine(result, before, "-")
    writeSingleLine(result, after, "+")
  }
  return result.end()
}

function writeSingleLine(result: ReturnType<typeof JsonString.counter>, value: string, prefix: "+" | "-") {
  if (value === "" || !result.write(prefix)) return
  const terminated = value.endsWith("\n")
  if (!result.write(value, 0, terminated ? value.length - 1 : value.length)) return
  if (!result.write("\n") || terminated) return
  result.write("\\ No newline at end of file\n")
}

function patchBytes(patch: StructuredPatch, maximum: number) {
  const result = JsonString.counter(maximum)
  writePatch(result, patch)
  return result.end()
}

function headerBytes(oldFile: string, newFile: string, maximum: number) {
  const result = JsonString.counter(maximum)
  writeHeader(result, oldFile, newFile)
  return result.end()
}

function writePatch(result: ReturnType<typeof JsonString.counter>, patch: StructuredPatch) {
  if (!writeHeader(result, patch.oldFileName, patch.newFileName, patch.oldHeader, patch.newHeader)) return false
  for (const hunk of patch.hunks) {
    if (
      !result.write(
        `@@ -${hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldLines} +${hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newLines} @@\n`,
      )
    )
      return false
    for (const line of hunk.lines) if (!result.write(line) || !result.write("\n")) return false
  }
  return true
}

function writeHeader(
  result: ReturnType<typeof JsonString.counter>,
  oldFile: string,
  newFile: string,
  oldHeader?: string,
  newHeader?: string,
) {
  if (oldFile === newFile && (!result.write("Index: ") || !result.write(oldFile) || !result.write("\n"))) return false
  if (
    !result.write("===================================================================\n--- ") ||
    !result.write(oldFile)
  )
    return false
  if (oldHeader !== undefined && (!result.write("\t") || !result.write(oldHeader))) return false
  if (!result.write("\n+++ ") || !result.write(newFile)) return false
  if (newHeader !== undefined && (!result.write("\t") || !result.write(newHeader))) return false
  return result.write("\n")
}

function countChanges(patch: StructuredPatch) {
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

function coarseBounded(
  oldFile: string,
  newFile: string,
  before: string,
  after: string,
  maximum: number,
  oldLines = countLines(before),
  newLines = countLines(after),
): BoundedInfo {
  const additions = before === after ? 0 : newLines
  const deletions = before === after ? 0 : oldLines
  const result = JsonString.counter(maximum)
  const structured = coarsePatch(oldFile, newFile, before, after, deletions, additions)
  if (writePatch(result, structured) && before !== after) {
    writePrefixed(result, before, "-")
    writePrefixed(result, after, "+")
  }
  const serializedBytes = result.end()
  if (serializedBytes > maximum) return { serializedBytes, additions, deletions }
  return { patch: coarse(oldFile, newFile, before, after).patch, serializedBytes, additions, deletions }
}

function writePrefixed(result: ReturnType<typeof JsonString.counter>, value: string, prefix: "+" | "-") {
  if (value === "" || !result.write(prefix)) return false
  const terminated = value.endsWith("\n")
  const end = terminated ? value.length - 1 : value.length
  let start = 0
  for (let index = 0; index < end; index++) {
    if (value.charCodeAt(index) !== 10) continue
    if (!result.write(value, start, index + 1) || !result.write(prefix)) return false
    start = index + 1
  }
  if (!result.write(value, start, end) || !result.write("\n")) return false
  return terminated || result.write("\\ No newline at end of file\n")
}

function coarse(oldFile: string, newFile: string, before: string, after: string): Info {
  const oldLines = countLines(before)
  const newLines = countLines(after)
  const structured = coarsePatch(oldFile, newFile, before, after, oldLines, newLines)
  return {
    patch: formatPatch(structured) + (before === after ? "" : prefixLines(before, "-") + prefixLines(after, "+")),
    additions: before === after ? 0 : newLines,
    deletions: before === after ? 0 : oldLines,
    coarse: true,
  }
}

function coarsePatch(
  oldFile: string,
  newFile: string,
  before: string,
  after: string,
  oldLines: number,
  newLines: number,
): StructuredPatch {
  return {
    oldFileName: oldFile,
    newFileName: newFile,
    oldHeader: "coarse diff after calculation limit",
    newHeader: "coarse diff after calculation limit",
    hunks:
      before === after
        ? []
        : [
            {
              oldStart: 1,
              oldLines,
              newStart: 1,
              newLines,
              lines: [],
            },
          ],
  }
}

function countLines(value: string) {
  if (value === "") return 0
  let lines = value.endsWith("\n") ? 0 : 1
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) lines++
  }
  return lines
}

function prefixLines(value: string, prefix: "+" | "-") {
  if (value === "") return ""
  const terminated = value.endsWith("\n")
  const body = terminated ? value.slice(0, -1) : value
  const lines = prefix + body.replaceAll("\n", `\n${prefix}`) + "\n"
  return terminated ? lines : lines + "\\ No newline at end of file\n"
}
