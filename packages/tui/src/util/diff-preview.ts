import { Buffer } from "node:buffer"

export const DIFF_PREVIEW_LIMITS = {
  maxPatchBytes: 100 * 1024,
  maxChangedLines: 500,
  maxPreviewLines: 40,
  maxPreviewCharacters: 8192,
  maxSetFiles: 20,
  maxSetBytes: 256 * 1024,
  maxFileTreeFiles: 500,
} as const

const omission = "... diff omitted ..."
const headLines = Math.floor((DIFF_PREVIEW_LIMITS.maxPreviewLines - 1) / 2)
const tailLines = DIFF_PREVIEW_LIMITS.maxPreviewLines - headLines - 1

export function measureDiff(diff: string) {
  const bytes = Buffer.byteLength(diff, "utf8")
  let additions = 0
  let deletions = 0
  let totalLines = 0
  let start = 0
  let oldLines = 0
  let newLines = 0

  for (let index = 0; index <= diff.length; index++) {
    if (index < diff.length && diff.charCodeAt(index) !== 10) continue
    if (start === diff.length) break

    totalLines++
    const prefix = diff.charCodeAt(start)
    if (prefix === 64 && diff.charCodeAt(start + 1) === 64) {
      const range = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(diff.slice(start, index))
      if (range) {
        oldLines = Number(range[1] ?? 1)
        newLines = Number(range[2] ?? 1)
      }
    } else if (prefix === 43 && newLines > 0) {
      additions++
      newLines--
    } else if (prefix === 45 && oldLines > 0) {
      deletions++
      oldLines--
    } else if (prefix === 32) {
      if (oldLines > 0) oldLines--
      if (newLines > 0) newLines--
    }
    start = index + 1
  }

  const changedLines = additions + deletions
  return {
    bytes,
    additions,
    deletions,
    changedLines,
    totalLines,
    limited: bytes > DIFF_PREVIEW_LIMITS.maxPatchBytes || changedLines > DIFF_PREVIEW_LIMITS.maxChangedLines,
  }
}

export function createDiffPreview(diff: string) {
  const measured = measureDiff(diff)
  return { ...measured, preview: preview(diff, measured.totalLines) }
}

export function shouldLimitDiffSet(patches: readonly (string | undefined)[]) {
  if (patches.length > DIFF_PREVIEW_LIMITS.maxSetFiles) return true
  return (
    patches.reduce((total, patch) => total + (patch === undefined ? 0 : Buffer.byteLength(patch, "utf8")), 0) >
    DIFF_PREVIEW_LIMITS.maxSetBytes
  )
}

export function formatDiffBytes(bytes: number) {
  const value = Math.max(0, Math.floor(bytes))
  if (value < 1024) return `${value} B`

  const units = ["KiB", "MiB", "GiB"] as const
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  const amount = value / 1024 ** (index + 1)
  return `${Number(amount.toFixed(amount < 10 ? 1 : 0))} ${units[index]}`
}

function preview(diff: string, totalLines: number) {
  if (totalLines <= DIFF_PREVIEW_LIMITS.maxPreviewLines && diff.length <= DIFF_PREVIEW_LIMITS.maxPreviewCharacters)
    return diff

  const contentCharacters = DIFF_PREVIEW_LIMITS.maxPreviewCharacters - omission.length - 2
  const headCharacters = Math.ceil(contentCharacters / 2)
  const tailCharacters = contentCharacters - headCharacters
  const head = diff.slice(0, previewHeadEnd(diff, headCharacters))
  const tail = diff.slice(previewTailStart(diff, tailCharacters))
  return `${head}${head.endsWith("\n") ? "" : "\n"}${omission}\n${tail}`
}

function previewHeadEnd(diff: string, maxCharacters: number) {
  const boundary = safeHeadBoundary(diff, Math.min(diff.length, maxCharacters))
  let lines = 0
  for (let index = 0; index < boundary; index++) {
    if (diff.charCodeAt(index) !== 10) continue
    lines++
    if (lines === headLines) return index + 1
  }
  return boundary
}

function previewTailStart(diff: string, maxCharacters: number) {
  let lineBoundary = 0
  let lines = 0
  const end = diff.endsWith("\n") ? diff.length - 1 : diff.length
  for (let index = end - 1; index >= 0; index--) {
    if (diff.charCodeAt(index) !== 10) continue
    lines++
    if (lines !== tailLines) continue
    lineBoundary = index + 1
    break
  }

  const characterBoundary = safeTailBoundary(diff, Math.max(0, diff.length - maxCharacters))
  return Math.max(lineBoundary, characterBoundary)
}

function safeHeadBoundary(value: string, boundary: number) {
  const previous = value.charCodeAt(boundary - 1)
  const next = value.charCodeAt(boundary)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return boundary - 1
  return boundary
}

function safeTailBoundary(value: string, boundary: number) {
  const current = value.charCodeAt(boundary)
  const previous = value.charCodeAt(boundary - 1)
  const next = value.charCodeAt(boundary + 1)
  if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return boundary + 1
  if (current === 13 && next === 10) return boundary + 2
  if (current === 10) return boundary + 1
  return boundary
}
