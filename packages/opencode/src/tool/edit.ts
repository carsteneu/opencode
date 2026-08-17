// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TextDiff } from "@opencode-ai/core/text-diff"
import * as Bom from "@/util/bom"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let additions = 0
          let deletions = 0
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              if (params.oldString === "") {
                const existed = yield* afs.existsSafe(filePath)
                if (existed) {
                  throw new Error(
                    "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
                  )
                }
                const next = Bom.split(params.newString)
                const desiredBom = next.bom
                contentOld = ""
                contentNew = next.text
                const initialDiff = TextDiff.create(filePath, filePath, contentOld, contentNew)
                diff = trimDiff(initialDiff.patch)
                additions = initialDiff.additions
                deletions = initialDiff.deletions
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                  const formattedDiff = TextDiff.create(filePath, filePath, contentOld, contentNew)
                  diff = trimDiff(formattedDiff.patch)
                  additions = formattedDiff.additions
                  deletions = formattedDiff.deletions
                }
                yield* events.publish(FileSystem.Event.Edited, { file: filePath })
                yield* events.publish(Watcher.Event.Updated, {
                  file: filePath,
                  event: "add",
                })
                return
              }

              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              const ending = detectLineEnding(contentOld)
              const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
              const replacement = convertToLineEnding(normalizeLineEndings(params.newString), ending)

              const next = Bom.split(replace(contentOld, old, replacement, params.replaceAll))
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              const initialDiff = TextDiff.create(
                filePath,
                filePath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(contentNew),
              )
              diff = trimDiff(initialDiff.patch)
              additions = initialDiff.additions
              deletions = initialDiff.deletions
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                const formattedDiff = TextDiff.create(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                )
                diff = trimDiff(formattedDiff.patch)
                additions = formattedDiff.additions
                deletions = formattedDiff.deletions
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
            }).pipe(Effect.orDie),
          )

          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const diagnostics = yield* lsp.diagnostics({ files: [normalizedFilePath], limit: 20 })
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65
const FUZZY_MAX_LINE_COMPARISONS = 250_000
const FUZZY_MAX_LEVENSHTEIN_CELLS = 4_000_000
const FUZZY_SEARCH_ERROR =
  "Refusing fuzzy replacement because the candidate search is too large. Re-read the file and provide a more exact oldString with distinctive context."

function fuzzySearchBudget() {
  let comparisons = 0
  let cells = 0

  function count() {
    comparisons++
    if (comparisons > FUZZY_MAX_LINE_COMPARISONS) throw new Error(FUZZY_SEARCH_ERROR)
  }

  return {
    count,
    distance(a: string, b: string) {
      count()
      if (a === b) return 0
      if (a === "" || b === "") return Math.max(a.length, b.length)
      const rows = Math.max(a.length, b.length)
      const columns = Math.min(a.length, b.length)
      if (rows > Math.floor((FUZZY_MAX_LEVENSHTEIN_CELLS - cells) / columns)) throw new Error(FUZZY_SEARCH_ERROR)
      cells += rows * columns
      return levenshtein(a, b)
    },
  }
}

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }

  const columns = a.length <= b.length ? a : b
  const rows = a.length <= b.length ? b : a
  const matrix = [new Uint32Array(columns.length + 1), new Uint32Array(columns.length + 1)]
  for (let column = 0; column <= columns.length; column++) matrix[0][column] = column

  for (let row = 1; row <= rows.length; row++) {
    const current = matrix[row % 2]
    const previous = matrix[(row - 1) % 2]
    current[0] = row
    for (let column = 1; column <= columns.length; column++) {
      const cost = rows[row - 1] === columns[column - 1] ? 0 : 1
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
    }
  }
  return matrix[rows.length % 2][columns.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

type LineSpan = {
  startLine: number
  start: number
  end: number
}

function indexLines(lines: string[]) {
  let end = 0
  const starts = lines.map((line) => {
    const start = end
    end += line.length + 1
    return start
  })
  return { starts, end }
}

function lineTrimmedMatches(content: string, find: string) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const indexed = indexLines(originalLines)
  const lineStarts = indexed.starts
  const searchTrimmed = searchLines.map((line) => line.trim())

  function* spans(): Generator<LineSpan> {
    if (searchTrimmed.length === 0) {
      // Preserve the exported replacer's historical empty-pattern boundary yields.
      for (let i = 0; i < lineStarts.length; i++) {
        yield { startLine: i, start: lineStarts[i], end: lineStarts[i] }
      }
      yield { startLine: originalLines.length, start: indexed.end, end: indexed.end }
      return
    }

    const originalTrimmed = originalLines.map((line) => line.trim())
    const prefix = new Uint32Array(searchTrimmed.length)
    let matched = 0

    for (let i = 1; i < searchTrimmed.length; ) {
      if (searchTrimmed[i] === searchTrimmed[matched]) {
        matched++
        prefix[i] = matched
        i++
        continue
      }
      if (matched > 0) {
        matched = prefix[matched - 1]
        continue
      }
      i++
    }

    matched = 0
    for (let i = 0; i < originalTrimmed.length; i++) {
      while (matched > 0 && originalTrimmed[i] !== searchTrimmed[matched]) matched = prefix[matched - 1]
      if (originalTrimmed[i] !== searchTrimmed[matched]) continue
      matched++
      if (matched < searchTrimmed.length) continue

      const startLine = i - searchTrimmed.length + 1
      yield { startLine, start: lineStarts[startLine], end: lineStarts[i] + originalLines[i].length }
      matched = prefix[matched - 1]
    }
  }

  return {
    originalLines,
    lineStarts,
    searchTrimmed,
    firstNonEmptyLine: searchTrimmed.findIndex((line) => line.length > 0),
    lastNonEmptyLine: searchTrimmed.findLastIndex((line) => line.length > 0),
    spans: spans(),
  }
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const matches = lineTrimmedMatches(content, find)
  for (const span of matches.spans) yield content.substring(span.start, span.end)
}

type LineSpanGroup = {
  span: LineSpan
  count: number
}

function groupLineSpans(lines: string[], lineCount: number, first: LineSpan, spans: Iterable<LineSpan>) {
  const ranking = lineWindowRanks(lines, lineCount)
  const byRank = new Map<bigint, LineSpanGroup>()
  const groups: LineSpanGroup[] = []

  function add(span: LineSpan) {
    const prefix = ranking.ranks[span.startLine]
    const suffix = ranking.ranks[span.startLine + lineCount - ranking.blockSize]
    // These exact ranks cover the full window because blockSize <= lineCount < 2 * blockSize.
    const key = lineRankPair(prefix, suffix)
    const hit = byRank.get(key)
    if (hit) {
      hit.count++
      return hit
    }

    const group = { span, count: 1 }
    byRank.set(key, group)
    groups.push(group)
    return group
  }

  const current = add(first)
  for (const span of spans) add(span)
  return { current, groups }
}

function lineWindowRanks(lines: string[], windowSize: number) {
  const lineIDs = new Map<string, number>()
  let ranks = new Uint32Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const hit = lineIDs.get(lines[i])
    if (hit !== undefined) {
      ranks[i] = hit
      continue
    }
    const id = lineIDs.size
    lineIDs.set(lines[i], id)
    ranks[i] = id
  }

  let blockSize = 1
  while (blockSize * 2 <= windowSize) {
    const pairs = new Map<bigint, number>()
    const next = new Uint32Array(lines.length - blockSize * 2 + 1)
    let nextRank = 0
    for (let i = 0; i < next.length; i++) {
      const prefix = ranks[i]
      const suffix = ranks[i + blockSize]
      const key = lineRankPair(prefix, suffix)
      const hit = pairs.get(key)
      if (hit !== undefined) {
        next[i] = hit
        continue
      }

      pairs.set(key, nextRank)
      next[i] = nextRank
      nextRank++
    }
    ranks = next
    blockSize *= 2
  }

  return { ranks, blockSize }
}

function lineRankPair(prefix: number, suffix: number) {
  return (BigInt(prefix) << 32n) | BigInt(suffix)
}

function lineTrimmedSpanLength(matches: ReturnType<typeof lineTrimmedMatches>, span: LineSpan) {
  if (matches.firstNonEmptyLine === -1) return 0
  const firstLineIndex = span.startLine + matches.firstNonEmptyLine
  const lastLineIndex = span.startLine + matches.lastNonEmptyLine
  const firstLine = matches.originalLines[firstLineIndex]
  const lastLine = matches.originalLines[lastLineIndex]
  const start = matches.lineStarts[firstLineIndex] + firstLine.length - firstLine.trimStart().length
  const end = matches.lineStarts[lastLineIndex] + lastLine.trimEnd().length
  return end - start
}

function indexTrimmedLines(lines: string[]) {
  const starts = lines.map((line) => line.length - line.trimStart().length)
  const ends = lines.map((line) => line.trimEnd().length)
  const nextNonEmpty = new Int32Array(lines.length + 1)
  nextNonEmpty[lines.length] = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    nextNonEmpty[i] = starts[i] < ends[i] ? i : nextNonEmpty[i + 1]
  }
  const previousNonEmpty = new Int32Array(lines.length)
  let previous = -1
  for (let i = 0; i < lines.length; i++) {
    if (starts[i] < ends[i]) previous = i
    previousNonEmpty[i] = previous
  }
  return { starts, ends, nextNonEmpty, previousNonEmpty }
}

function lineSpanTrimmedLength(
  indexed: ReturnType<typeof indexTrimmedLines>,
  lineStarts: number[],
  lineCount: number,
  span: LineSpan,
) {
  const first = indexed.nextNonEmpty[span.startLine]
  const last = indexed.previousNonEmpty[span.startLine + lineCount - 1]
  if (first > last) return 0
  return lineStarts[last] + indexed.ends[last] - lineStarts[first] - indexed.starts[first]
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const originalTrimmed = originalLines.map((line) => line.trim())
  const searchTrimmed = searchLines.map((line) => line.trim())
  const firstLineSearch = searchTrimmed[0]
  const lastLineSearch = searchTrimmed[searchTrimmed.length - 1]
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))
  const lastLineIndexes = originalTrimmed.flatMap((line, index) => (line === lastLineSearch ? [index] : []))
  const budget = fuzzySearchBudget()

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  let lastLineCursor = 0
  for (let i = 0; i < originalLines.length; i++) {
    if (originalTrimmed[i] !== firstLineSearch) {
      continue
    }

    while (lastLineIndexes[lastLineCursor] < i + 2) lastLineCursor++
    const endLine = lastLineIndexes[lastLineCursor]
    if (endLine === undefined) break
    const actualBlockSize = endLine - i + 1
    if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
      candidates.push({ startLine: i, endLine })
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalTrimmed[startLine + j]
        const searchLine = searchTrimmed[j]
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          budget.count()
          continue
        }
        const distance = budget.distance(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      const lineStarts = indexLines(originalLines).starts
      yield content.substring(lineStarts[startLine], lineStarts[endLine] + originalLines[endLine].length)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalTrimmed[startLine + j]
        const searchLine = searchTrimmed[j]
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          budget.count()
          continue
        }
        const distance = budget.distance(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    const lineStarts = indexLines(originalLines).starts
    yield content.substring(lineStarts[startLine], lineStarts[endLine] + originalLines[endLine].length)
  }
}

function whitespaceNormalizedMatches(content: string, find: string) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)
  const lines = content.split("\n")
  let indexedLines: ReturnType<typeof indexLines> | undefined
  const lineStarts = () => (indexedLines ??= indexLines(lines)).starts
  const normalizedCache: Array<string | undefined> = []
  const normalizedLine = (index: number) =>
    normalizedCache[index] ?? (normalizedCache[index] = normalizeWhitespace(lines[index]))

  function* singles() {
    let regex: RegExp | undefined
    let invalidRegex = false
    for (let i = 0; i < lines.length; i++) {
      if (normalizedLine(i) === normalizedFind) {
        yield lines[i]
        continue
      }
      if (!normalizedLine(i).includes(normalizedFind)) continue

      if (!regex && !invalidRegex) {
        const words = find.trim().split(/\s+/)
        const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
        try {
          regex = new RegExp(pattern)
        } catch {
          invalidRegex = true
        }
      }
      if (regex) {
        const match = lines[i].match(regex)
        if (match) yield match[0]
      }
    }
  }

  function* spans(): Generator<LineSpan> {
    const lineCount = find.split("\n").length
    if (lineCount <= 1 || lineCount > lines.length) return

    const starts = new Array<number>(lines.length)
    const ends = new Array<number>(lines.length)
    const parts: string[] = []
    let offset = 0
    for (let i = 0; i < lines.length; i++) {
      const normalized = normalizedLine(i)
      if (normalized === "") {
        starts[i] = offset
        ends[i] = offset
        continue
      }
      if (parts.length > 0) offset++
      starts[i] = offset
      offset += normalized.length
      ends[i] = offset
      parts.push(normalized)
    }

    const normalizedContent = parts.join(" ")
    const occurrences = normalizedFind === "" ? undefined : findOccurrences(normalizedContent, normalizedFind)
    const nextNonEmpty = new Int32Array(lines.length + 1)
    nextNonEmpty[lines.length] = lines.length
    for (let i = lines.length - 1; i >= 0; i--) {
      nextNonEmpty[i] = normalizedLine(i) === "" ? nextNonEmpty[i + 1] : i
    }
    const previousNonEmpty = new Int32Array(lines.length)
    let previous = -1
    for (let i = 0; i < lines.length; i++) {
      if (normalizedLine(i) !== "") previous = i
      previousNonEmpty[i] = previous
    }

    for (let i = 0; i <= lines.length - lineCount; i++) {
      const endLine = i + lineCount - 1
      const first = nextNonEmpty[i]
      const last = previousNonEmpty[endLine]
      const empty = first > endLine
      const matches = empty
        ? normalizedFind === ""
        : ends[last] - starts[first] === normalizedFind.length && occurrences?.[starts[first]] === 1
      if (!matches) continue
      const indexed = lineStarts()
      yield { startLine: i, start: indexed[i], end: indexed[endLine] + lines[endLine].length }
    }
  }

  return { lines, lineStarts, lineCount: find.split("\n").length, singles: singles(), spans: spans() }
}

function findOccurrences(content: string, find: string) {
  const result = new Uint8Array(content.length + 1)
  const prefix = new Uint32Array(find.length)
  let matched = 0
  for (let i = 1; i < find.length; ) {
    if (find[i] === find[matched]) {
      matched++
      prefix[i] = matched
      i++
      continue
    }
    if (matched > 0) {
      matched = prefix[matched - 1]
      continue
    }
    i++
  }

  matched = 0
  for (let i = 0; i < content.length; i++) {
    while (matched > 0 && content[i] !== find[matched]) matched = prefix[matched - 1]
    if (content[i] !== find[matched]) continue
    matched++
    if (matched < find.length) continue
    result[i - find.length + 1] = 1
    matched = prefix[matched - 1]
  }
  return result
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const matches = whitespaceNormalizedMatches(content, find)
  yield* matches.singles
  for (const span of matches.spans) yield content.substring(span.start, span.end)
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

function unescapeEditString(value: string) {
  return value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
    switch (capturedChar) {
      case "n":
        return "\n"
      case "t":
        return "\t"
      case "r":
        return "\r"
      case "'":
        return "'"
      case '"':
        return '"'
      case "`":
        return "`"
      case "\\":
        return "\\"
      case "\n":
        return "\n"
      case "$":
        return "$"
      default:
        return match
    }
  })
}

function prefixMatchLengths(pattern: string, content: string) {
  const contentOffset = pattern.length + 1
  const values = new Uint32Array(contentOffset + content.length)
  const charAt = (index: number) => {
    if (index < pattern.length) return pattern.charCodeAt(index)
    if (index === pattern.length) return -1
    return content.charCodeAt(index - contentOffset)
  }
  let left = 0
  let right = 0
  for (let i = 1; i < values.length; i++) {
    if (i <= right) values[i] = Math.min(right - i + 1, values[i - left])
    while (i + values[i] < values.length && charAt(values[i]) === charAt(i + values[i])) values[i]++
    if (i + values[i] - 1 > right) {
      left = i
      right = i + values[i] - 1
    }
  }
  return { values, contentOffset }
}

function escapeNormalizedMatches(content: string, find: string) {
  const unescapedFind = unescapeEditString(find)
  let splitLines: string[] | undefined
  const lines = () => (splitLines ??= content.split("\n"))
  let indexedLines: ReturnType<typeof indexLines> | undefined
  const lineStarts = () => (indexedLines ??= indexLines(lines())).starts

  function* direct() {
    if (content.includes(unescapedFind)) yield unescapedFind
  }

  function* spans(): Generator<LineSpan> {
    const lineCount = unescapedFind.split("\n").length
    const source = lines()
    if (lineCount > source.length) return

    const internal = source.map((line) => unescapeEditString(`${line}\n`))
    const internalOffsets = new Array<number>(source.length + 1)
    internalOffsets[0] = 0
    for (let i = 0; i < internal.length; i++) internalOffsets[i + 1] = internalOffsets[i] + internal[i].length
    const internalContent = internal.join("")
    const prefixMatches = prefixMatchLengths(unescapedFind, internalContent)

    for (let i = 0; i <= source.length - lineCount; i++) {
      const endLine = i + lineCount - 1
      const prefixStart = internalOffsets[i]
      const prefixLength = internalOffsets[endLine] - prefixStart
      if (prefixLength > unescapedFind.length) continue
      if (prefixLength > 0 && prefixMatches.values[prefixMatches.contentOffset + prefixStart] < prefixLength) {
        continue
      }
      const final = unescapeEditString(source[endLine])
      if (final.length !== unescapedFind.length - prefixLength) continue
      if (!unescapedFind.startsWith(final, prefixLength)) continue
      const indexed = lineStarts()
      yield { startLine: i, start: indexed[i], end: indexed[endLine] + source[endLine].length }
    }
  }

  return { lines, lineStarts, lineCount: unescapedFind.split("\n").length, direct: direct(), spans: spans() }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const matches = escapeNormalizedMatches(content, find)
  yield* matches.direct
  for (const span of matches.spans) yield content.substring(span.start, span.end)
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

function contextAwareMatches(content: string, find: string) {
  const findLines = find.split("\n")
  if (findLines.length < 3) return

  if (findLines[findLines.length - 1] === "") findLines.pop()

  const contentLines = content.split("\n")
  const contentTrimmed = contentLines.map((line) => line.trim())
  const findTrimmed = findLines.map((line) => line.trim())
  let indexedLines: ReturnType<typeof indexLines> | undefined
  const lineStarts = () => (indexedLines ??= indexLines(contentLines)).starts
  const lastLineIndexes = contentTrimmed.flatMap((line, index) =>
    line === findTrimmed[findTrimmed.length - 1] ? [index] : [],
  )

  function* spans(): Generator<LineSpan> {
    const budget = fuzzySearchBudget()
    let lastLineCursor = 0
    for (let i = 0; i < contentLines.length; i++) {
      if (contentTrimmed[i] !== findTrimmed[0]) continue

      while (lastLineIndexes[lastLineCursor] < i + 2) lastLineCursor++
      const endLine = lastLineIndexes[lastLineCursor]
      if (endLine === undefined) break
      if (endLine - i + 1 !== findLines.length) continue

      let matchingLines = 0
      let totalNonEmptyLines = 0
      for (let k = 1; k < findLines.length - 1; k++) {
        budget.count()
        const blockLine = contentTrimmed[i + k]
        const findLine = findTrimmed[k]
        if (blockLine.length > 0 || findLine.length > 0) {
          totalNonEmptyLines++
          if (blockLine === findLine) matchingLines++
        }
      }

      if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
        const indexed = lineStarts()
        yield { startLine: i, start: indexed[i], end: indexed[endLine] + contentLines[endLine].length }
      }
    }
  }

  return { lines: contentLines, lineStarts, lineCount: findLines.length, spans: spans() }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const matches = contextAwareMatches(content, find)
  if (!matches) return
  for (const span of matches.spans) yield content.substring(span.start, span.end)
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

const CANDIDATE_CACHE_MAX_KEY_BYTES = 64 * 1024
const CANDIDATE_CACHE_MAX_BYTES = 4 * 1024 * 1024
const CANDIDATE_CACHE_MAX_KEYS = 16_384
const MULTIPLE_MATCH_ERROR =
  "Found multiple matches for oldString. Provide more surrounding context to make the match unique."

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  const oldLineCount = oldString.split("\n").length
  const oldTrimmedLength = oldString.trim().length
  let notFound = true
  const seen = new Map<string, "missing" | "multiple">()
  let seenBytes = 0
  let cacheCandidates = true

  function disableCandidateCache() {
    seen.clear()
    seenBytes = 0
    cacheCandidates = false
  }

  function getCachedCandidate(search: string) {
    if (!cacheCandidates) return
    if (search.length * 2 <= CANDIDATE_CACHE_MAX_KEY_BYTES) return seen.get(search)
    disableCandidateCache()
  }

  function cacheCandidate(search: string, status: "missing" | "multiple") {
    if (!cacheCandidates) return
    const bytes = search.length * 2
    if (seenBytes + bytes > CANDIDATE_CACHE_MAX_BYTES || seen.size >= CANDIDATE_CACHE_MAX_KEYS) {
      disableCandidateCache()
      return
    }
    seen.set(search, status)
    seenBytes += bytes
  }

  function assertProportionate(lineCount: number, trimmedLength: number) {
    if (!isDisproportionateMatch(lineCount, trimmedLength, oldLineCount, oldTrimmedLength)) return
    throw new Error(
      "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
    )
  }

  function checkCandidate(search: string, knownMultiple = false) {
    const cached = getCachedCandidate(search)
    if (cached) return { type: cached }
    const index = knownMultiple ? 0 : content.indexOf(search)
    if (index === -1) {
      cacheCandidate(search, "missing")
      return { type: "missing" as const }
    }
    notFound = false
    assertProportionate(search.split("\n").length, search.trim().length)
    if (replaceAll) return { type: "replacement" as const, content: content.replaceAll(search, newString) }
    if (knownMultiple || index !== content.lastIndexOf(search)) {
      cacheCandidate(search, "multiple")
      return { type: "multiple" as const }
    }
    return {
      type: "replacement" as const,
      content: content.substring(0, index) + newString + content.substring(index + search.length),
    }
  }

  function checkLineSpans(lines: string[], lineStarts: () => number[], lineCount: number, spans: Iterable<LineSpan>) {
    for (const span of spans) {
      const search = content.substring(span.start, span.end)
      const result = checkCandidate(search)
      if (result.type === "replacement") return { type: "replacement" as const, content: result.content }
      if (result.type !== "multiple") continue

      const grouped = groupLineSpans(lines, lineCount, span, spans)
      const indexed = indexTrimmedLines(lines)
      const starts = lineStarts()
      for (const group of grouped.groups) {
        if (group === grouped.current) continue
        if (group.count > 1) {
          notFound = false
          assertProportionate(lineCount, lineSpanTrimmedLength(indexed, starts, lineCount, group.span))
          continue
        }
        const candidate = content.substring(group.span.start, group.span.end)
        const next = checkCandidate(candidate)
        if (next.type === "replacement") return { type: "replacement" as const, content: next.content }
      }
      return { type: "multiple" as const }
    }
    return { type: "missing" as const }
  }

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
  ]) {
    if (replacer === LineTrimmedReplacer) {
      const matches = lineTrimmedMatches(content, oldString)
      for (const span of matches.spans) {
        const search = content.substring(span.start, span.end)
        const result = checkCandidate(search)
        if (result.type === "replacement") return result.content
        if (result.type !== "multiple") continue

        if (search.includes("\n")) {
          const grouped = groupLineSpans(matches.originalLines, matches.searchTrimmed.length, span, matches.spans)
          for (const group of grouped.groups) {
            if (group === grouped.current) continue
            if (group.count > 1) {
              notFound = false
              assertProportionate(matches.searchTrimmed.length, lineTrimmedSpanLength(matches, group.span))
              continue
            }
            const candidate = content.substring(group.span.start, group.span.end)
            const next = checkCandidate(candidate)
            if (next.type === "replacement") return next.content
          }
          throw new Error(MULTIPLE_MATCH_ERROR)
        }

        const counts = new Map([[search, 1]])
        for (const candidateSpan of matches.spans) {
          const candidate = content.substring(candidateSpan.start, candidateSpan.end)
          const count = counts.get(candidate)
          if (count !== undefined) {
            counts.set(candidate, count + 1)
            continue
          }
          if (!getCachedCandidate(candidate)) counts.set(candidate, 1)
        }
        counts.delete(search)
        for (const [candidate, count] of counts) {
          const next = checkCandidate(candidate, count > 1)
          if (next.type === "replacement") return next.content
        }
        throw new Error(MULTIPLE_MATCH_ERROR)
      }
      continue
    }

    if (replacer === WhitespaceNormalizedReplacer) {
      const matches = whitespaceNormalizedMatches(content, oldString)
      let multiple = false
      for (const search of matches.singles) {
        const result = checkCandidate(search)
        if (result.type === "replacement") return result.content
        if (result.type !== "multiple") continue

        multiple = true
        const counts = new Map<string, number>()
        for (const candidate of matches.singles) {
          const count = counts.get(candidate)
          if (count !== undefined) {
            counts.set(candidate, count + 1)
            continue
          }
          if (!getCachedCandidate(candidate)) counts.set(candidate, 1)
        }
        for (const [candidate, count] of counts) {
          const next = checkCandidate(candidate, count > 1)
          if (next.type === "replacement") return next.content
        }
        break
      }
      const result = checkLineSpans(matches.lines, matches.lineStarts, matches.lineCount, matches.spans)
      if (result.type === "replacement") return result.content
      if (multiple || result.type === "multiple") throw new Error(MULTIPLE_MATCH_ERROR)
      continue
    }

    if (replacer === EscapeNormalizedReplacer) {
      const matches = escapeNormalizedMatches(content, oldString)
      let multiple = false
      for (const search of matches.direct) {
        const result = checkCandidate(search)
        if (result.type === "replacement") return result.content
        if (result.type === "multiple") multiple = true
      }
      const result = checkLineSpans(matches.lines(), matches.lineStarts, matches.lineCount, matches.spans)
      if (result.type === "replacement") return result.content
      if (multiple || result.type === "multiple") throw new Error(MULTIPLE_MATCH_ERROR)
      continue
    }

    if (replacer === TrimmedBoundaryReplacer) {
      const search = oldString.trim()
      if (search === oldString || !content.includes(search)) continue
      const result = checkCandidate(search)
      if (result.type === "replacement") return result.content
      continue
    }

    if (replacer === ContextAwareReplacer) {
      const matches = contextAwareMatches(content, oldString)
      if (!matches) continue
      const result = checkLineSpans(matches.lines, matches.lineStarts, matches.lineCount, matches.spans)
      if (result.type === "replacement") return result.content
      if (result.type === "multiple") throw new Error(MULTIPLE_MATCH_ERROR)
      continue
    }

    for (const search of replacer(content, oldString)) {
      const result = checkCandidate(search)
      if (result.type === "replacement") return result.content
      if (replacer === SimpleReplacer && result.type === "multiple") throw new Error(MULTIPLE_MATCH_ERROR)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error(MULTIPLE_MATCH_ERROR)
}

function isDisproportionateMatch(
  lineCount: number,
  trimmedLength: number,
  oldLineCount: number,
  oldTrimmedLength: number,
) {
  if (lineCount >= Math.max(oldLineCount + 3, oldLineCount * 2)) return true
  if (oldLineCount === 1) return false
  return trimmedLength > Math.max(oldTrimmedLength + 500, oldTrimmedLength * 4)
}
