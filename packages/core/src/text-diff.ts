export * as TextDiff from "./text-diff"

import { formatPatch, structuredPatch, type StructuredPatch } from "diff"

const DEFAULT_TIMEOUT = 250

export interface Info {
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly coarse: boolean
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

function coarse(oldFile: string, newFile: string, before: string, after: string): Info {
  const oldLines = countLines(before)
  const newLines = countLines(after)

  const structured: StructuredPatch = {
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
  return {
    patch: formatPatch(structured) + (before === after ? "" : prefixLines(before, "-") + prefixLines(after, "+")),
    additions: before === after ? 0 : newLines,
    deletions: before === after ? 0 : oldLines,
    coarse: true,
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
