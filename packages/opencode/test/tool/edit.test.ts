import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EditTool,
  EscapeNormalizedReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  replace,
  TrimmedBoundaryReplacer,
  WhitespaceNormalizedReplacer,
} from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

// Frozen pre-optimization behavior for small differential cases only.
function legacyLineTrimmedCandidates(content: string, find: string) {
  const originalLines = content.split("\n")
  const splitSearch = find.split("\n")
  const searchLines = splitSearch.at(-1) === "" ? splitSearch.slice(0, -1) : splitSearch
  return Array.from({ length: Math.max(0, originalLines.length - searchLines.length + 1) }, (_, index) => index)
    .filter((index) => searchLines.every((line, offset) => originalLines[index + offset].trim() === line.trim()))
    .map((index) => {
      const start = originalLines.slice(0, index).reduce((total, line) => total + line.length + 1, 0)
      const length = originalLines
        .slice(index, index + searchLines.length)
        .reduce((total, line, offset) => total + line.length + (offset < searchLines.length - 1 ? 1 : 0), 0)
      return content.substring(start, start + length)
    })
}

function legacyLineWindows(content: string, lineCount: number) {
  const lines = content.split("\n")
  return Array.from({ length: Math.max(0, lines.length - lineCount + 1) }, (_, index) =>
    lines.slice(index, index + lineCount).join("\n"),
  )
}

// Frozen pre-span behavior for small differential cases only.
function legacyWhitespaceNormalizedCandidates(content: string, find: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const singles = content.split("\n").flatMap((line) => {
    const normalizedLine = normalize(line)
    if (normalizedLine === normalizedFind) return [line]
    if (!normalizedLine.includes(normalizedFind)) return []
    const pattern = find
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+")
    const match = line.match(new RegExp(pattern))
    return match ? [match[0]] : []
  })
  const lineCount = find.split("\n").length
  const windows =
    lineCount > 1
      ? legacyLineWindows(content, lineCount).filter((candidate) => normalize(candidate) === normalizedFind)
      : []
  return [...singles, ...windows]
}

function legacyRemoveIndentation(value: string) {
  const lines = value.split("\n")
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  if (nonEmpty.length === 0) return value
  const indentation = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0))
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(indentation))).join("\n")
}

function legacyIndentationFlexibleCandidates(content: string, find: string) {
  const normalizedFind = legacyRemoveIndentation(find)
  return legacyLineWindows(content, find.split("\n").length).filter(
    (candidate) => legacyRemoveIndentation(candidate) === normalizedFind,
  )
}

function legacyUnescapeEditString(value: string) {
  return value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
    if (captured === "n") return "\n"
    if (captured === "t") return "\t"
    if (captured === "r") return "\r"
    if (captured === "'" || captured === '"' || captured === "`" || captured === "$" || captured === "\n") {
      return captured
    }
    if (captured === "\\") return "\\"
    return match
  })
}

function legacyEscapeNormalizedCandidates(content: string, find: string) {
  const normalizedFind = legacyUnescapeEditString(find)
  const direct = content.includes(normalizedFind) ? [normalizedFind] : []
  const windows = legacyLineWindows(content, normalizedFind.split("\n").length).filter(
    (candidate) => legacyUnescapeEditString(candidate) === normalizedFind,
  )
  return [...direct, ...windows]
}

function legacyTrimmedBoundaryCandidates(content: string, find: string) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return []
  const direct = content.includes(trimmedFind) ? [trimmedFind] : []
  const windows = legacyLineWindows(content, find.split("\n").length).filter(
    (candidate) => candidate.trim() === trimmedFind,
  )
  return [...direct, ...windows]
}

function legacyContextAwareCandidates(content: string, find: string) {
  const splitFind = find.split("\n")
  if (splitFind.length < 3) return []
  const findLines = splitFind.at(-1) === "" ? splitFind.slice(0, -1) : splitFind
  const contentLines = content.split("\n")
  const first = findLines[0].trim()
  const last = findLines.at(-1)?.trim()

  return contentLines.flatMap((line, start) => {
    if (line.trim() !== first) return []
    const end = contentLines.findIndex((candidate, index) => index >= start + 2 && candidate.trim() === last)
    if (end === -1 || end - start + 1 !== findLines.length) return []
    const block = contentLines.slice(start, end + 1)
    const comparable = block.slice(1, -1).flatMap((candidate, index) => {
      const actual = candidate.trim()
      const expected = findLines[index + 1].trim()
      return actual.length > 0 || expected.length > 0 ? [{ actual, expected }] : []
    })
    const matching = comparable.filter((candidate) => candidate.actual === candidate.expected).length
    return comparable.length === 0 || matching / comparable.length >= 0.5 ? [block.join("\n")] : []
  })
}

function elapsedLineTrimmed(content: string, find: string) {
  const started = performance.now()
  let matches = 0
  for (const _ of LineTrimmedReplacer(content, find)) matches++
  return { elapsed: performance.now() - started, matches }
}

function repeatedLines(count: number, line: string) {
  return Array.from({ length: count }, () => line).join("\n")
}

function distinctRepeatedTrimmedLines(count: number) {
  const unique = count / 2
  const width = Math.ceil(Math.log2(unique))
  const candidates = Array.from({ length: unique }, (_, index) => {
    const whitespace = index.toString(2).padStart(width, "0").replaceAll("0", "\t").replaceAll("1", " ")
    return `${whitespace}needle${whitespace}`
  })
  return [...candidates, ...candidates].join("\n")
}

const multipleMatchError =
  "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
const fuzzySearchError =
  "Refusing fuzzy replacement because the candidate search is too large. Re-read the file and provide a more exact oldString with distinctive context."

describe("line-trimmed replacer compatibility", () => {
  const golden = [
    {
      name: "LF",
      content: "head\n  alpha  \n\tbeta \nfoot",
      find: "alpha\nbeta",
      matches: [{ candidate: "  alpha  \n\tbeta ", start: 5, end: 21 }],
    },
    {
      name: "CRLF and Unicode",
      content: "head\r\n\u2003cafe\u0301 🧪\u00a0\r\n\t東京 ✨\r\nfoot",
      find: "cafe\u0301 🧪\n東京 ✨\n",
      matches: [{ candidate: "\u2003cafe\u0301 🧪\u00a0\r\n\t東京 ✨\r", start: 6, end: 24 }],
    },
    {
      name: "blank lines",
      content: "a\n  \n\t\nb",
      find: " \n\t\n",
      matches: [{ candidate: "  \n\t", start: 2, end: 6 }],
    },
    {
      name: "no final newline",
      content: "head\n alpha \n\tbeta",
      find: "alpha\nbeta\n",
      matches: [{ candidate: " alpha \n\tbeta", start: 5, end: 18 }],
    },
    {
      name: "final content newline",
      content: "head\n value \n",
      find: "value",
      matches: [{ candidate: " value ", start: 5, end: 12 }],
    },
    {
      name: "repeated lines",
      content: " x \n\tx\t\n  x  \nend",
      find: "x",
      matches: [
        { candidate: " x ", start: 0, end: 3 },
        { candidate: "\tx\t", start: 4, end: 7 },
        { candidate: "  x  ", start: 8, end: 13 },
      ],
    },
    {
      name: "overlapping matches",
      content: " a \n\ta\t\n a \n\ta\t",
      find: "a\na",
      matches: [
        { candidate: " a \n\ta\t", start: 0, end: 7 },
        { candidate: "\ta\t\n a ", start: 4, end: 11 },
        { candidate: " a \n\ta\t", start: 8, end: 15 },
      ],
    },
    {
      name: "single trailing search newline is removed",
      content: "alpha\n\nalpha\n",
      find: "alpha\n\n",
      matches: [
        { candidate: "alpha\n", start: 0, end: 6 },
        { candidate: "alpha\n", start: 7, end: 13 },
      ],
    },
  ]

  for (const scenario of golden) {
    test(`preserves ${scenario.name} candidates, offsets, and order`, () => {
      const candidates = [...LineTrimmedReplacer(scenario.content, scenario.find)]
      const located = candidates.reduce<Array<{ candidate: string; start: number; end: number }>>(
        (matches, candidate) => {
          const start = scenario.content.indexOf(candidate, (matches.at(-1)?.start ?? -1) + 1)
          return [...matches, { candidate, start, end: start + candidate.length }]
        },
        [],
      )
      expect(located).toEqual(scenario.matches)
    })
  }

  test("preserves historical empty-pattern yields", () => {
    expect([...LineTrimmedReplacer("", "")]).toEqual(["", ""])
    expect([...LineTrimmedReplacer("a\nb", "")]).toEqual(["", "", ""])
    expect([...LineTrimmedReplacer("a\n", "")]).toEqual(["", "", ""])
  })

  test("matches the legacy implementation across fixed-seed randomized inputs", () => {
    let state = 0x5eed1234
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]
    const atoms = ["alpha", "βeta", "猫", "🧪", "e\u0301", "same", ""] as const
    const padding = ["", " ", "\t", "\u2003", "\u00a0"] as const
    const decorate = (value: string) => `${pick(padding)}${value}${pick(padding)}`

    for (let iteration = 0; iteration < 250; iteration++) {
      const logical = Array.from({ length: 1 + Math.floor(random() * 10) }, () => pick(atoms))
      const contentSeparator = random() < 0.5 ? "\n" : "\r\n"
      const content = logical.map(decorate).join(contentSeparator) + (random() < 0.5 ? contentSeparator : "")
      const start = Math.floor(random() * logical.length)
      const count = 1 + Math.floor(random() * (logical.length - start))
      const searchSeparator = random() < 0.5 ? "\n" : "\r\n"
      const selected = random() < 0.75 ? logical.slice(start, start + count) : ["missing", ...logical.slice(0, count)]
      const find =
        iteration % 31 === 0
          ? ""
          : selected.map(decorate).join(searchSeparator) + (random() < 0.5 ? searchSeparator : "")
      const expected = legacyLineTrimmedCandidates(content, find)
      const actual = [...LineTrimmedReplacer(content, find)]
      expect({ iteration, candidates: actual }).toEqual({ iteration, candidates: expected })
    }
  })

  test("scales near-linearly for repeated one-line matches", () => {
    elapsedLineTrimmed(repeatedLines(2_048, "  match  "), "match")
    const small = elapsedLineTrimmed(repeatedLines(32_000, "  match  "), "match")
    const large = elapsedLineTrimmed(repeatedLines(64_000, "  match  "), "match")

    expect(small.matches).toBe(32_000)
    expect(large.matches).toBe(64_000)
    expect(large.elapsed).toBeLessThan(small.elapsed * 3 + 75)
  })

  test("scales near-linearly for an adversarial long-prefix miss", () => {
    const measure = (lines: number) => {
      const pattern = repeatedLines(lines / 32 - 1, "prefix") + "\nmissing"
      return elapsedLineTrimmed(repeatedLines(lines, "prefix"), pattern)
    }
    measure(2_048)
    const small = measure(32_000)
    const large = measure(64_000)

    expect(small.matches).toBe(0)
    expect(large.matches).toBe(0)
    expect(large.elapsed).toBeLessThan(small.elapsed * 3 + 75)
  })
})

describe("whitespace-normalized replacer compatibility", () => {
  test("preserves single-line substrings, CRLF, Unicode whitespace, and regex punctuation", () => {
    expect([
      ...WhitespaceNormalizedReplacer(
        "head\n\u2003alpha\t beta\u00a0\r\nprefix alpha   beta suffix\nfoot",
        "alpha beta",
      ),
    ]).toEqual(["\u2003alpha\t beta\u00a0\r", "alpha   beta"])
    expect([...WhitespaceNormalizedReplacer("head a+b    (c) tail", "a+b (c)")]).toEqual(["a+b    (c)"])
  })

  test("preserves blank multiline windows and raw candidate order", () => {
    const content = "alpha\n\u2003\nbeta gamma\nstop\nalpha beta\n \ngamma"
    expect([...WhitespaceNormalizedReplacer(content, "alpha beta\n\t\ngamma")]).toEqual([
      "alpha\n\u2003\nbeta gamma",
      "alpha beta\n \ngamma",
    ])

    const repeated = "alpha\nbeta   gamma"
    const unique = "alpha\tbeta\n gamma "
    const find = "alpha beta\ngamma"
    const grouped = [repeated, "STOP", unique, "STOP", repeated].join("\n")
    expect([...LineTrimmedReplacer(grouped, find)]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(grouped, find)]).toEqual([repeated, unique, repeated])
    expect(replace(grouped, find, "changed")).toBe([repeated, "STOP", "changed", "STOP", repeated].join("\n"))
  })

  test("matches the legacy implementation across fixed-seed randomized inputs", () => {
    let state = 0xf0221e
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]
    const atoms = ["", "alpha", " beta ", "alpha  beta", "\t\u03b3\u00a0", "a+b (c)", "\u732b", "same"] as const

    for (let iteration = 0; iteration < 300; iteration++) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 9) }, () => pick(atoms))
      const contentSeparator = random() < 0.5 ? "\n" : "\r\n"
      const content = lines.join(contentSeparator) + (random() < 0.25 ? contentSeparator : "")
      const start = Math.floor(random() * lines.length)
      const selected =
        random() < 0.7
          ? lines.slice(start, start + 1 + Math.floor(random() * (lines.length - start)))
          : Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(atoms))
      const find =
        selected
          .map((line) => (random() < 0.5 ? line.trim().replace(/\s+/g, random() < 0.5 ? " " : "\t") : line))
          .join(random() < 0.5 ? "\n" : "\r\n") + (random() < 0.2 ? "\n" : "")
      expect({ iteration, candidates: [...WhitespaceNormalizedReplacer(content, find)] }).toEqual({
        iteration,
        candidates: legacyWhitespaceNormalizedCandidates(content, find),
      })
    }
  })

  test("scales near-linearly for long normalized windows that do not match", () => {
    const measure = (lines: number) => {
      const find = `${repeatedLines(lines / 32 - 1, "alpha beta")}\nmissing`
      const started = performance.now()
      const candidates = [...WhitespaceNormalizedReplacer(repeatedLines(lines, "alpha   beta"), find)]
      return { elapsed: performance.now() - started, candidates }
    }
    measure(2_048)
    const small = measure(16_000)
    const large = measure(32_000)

    expect(small.candidates).toEqual([])
    expect(large.candidates).toEqual([])
    expect(large.elapsed).toBeLessThan(small.elapsed * 3 + 75)
  })

  test("scales near-linearly for dense normalized occurrences used by multiline lookup", () => {
    const measure = (lines: number) => {
      const started = performance.now()
      let candidates = 0
      for (const _ of WhitespaceNormalizedReplacer(repeatedLines(lines, "a"), "a\n ")) candidates++
      return { elapsed: performance.now() - started, candidates }
    }
    measure(200_000)
    const small = measure(1_000_000)
    const large = measure(2_000_000)

    expect(small.candidates).toBe(1_000_000)
    expect(large.candidates).toBe(2_000_000)
    expect(large.elapsed).toBeLessThan(small.elapsed * 2.75 + 75)
  })

  test("scales near-linearly for duplicated windows with long blank edges", () => {
    const measure = (window: number) => {
      const blank = "\u2003"
      const region = [
        ...Array.from({ length: window - 1 }, () => blank),
        `${" ".repeat(128)}x`,
        `y${"\u00a0".repeat(128)}`,
        ...Array.from({ length: window - 1 }, () => blank),
      ].join("\n")
      const content = `${region}\nSTOP\n${region}`
      const find = ["x y", ...Array.from({ length: window - 1 }, () => "")].join("\n")
      const started = performance.now()
      expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(2_000)
    const small = Math.min(measure(8_000), measure(8_000))
    const large = Math.min(measure(16_000), measure(16_000))

    expect(large).toBeLessThan(small * 3 + 100)
  })

  test("scales near-linearly for distinct duplicated single-line candidates", () => {
    const measure = (count: number) => {
      const variants = Array.from({ length: count }, (_, index) => {
        const whitespace = index.toString(2).padStart(16, "0").replaceAll("0", " ").replaceAll("1", "\t")
        return `a${whitespace}b`
      })
      const content = [...variants, ...variants].join("\n")
      expect([...LineTrimmedReplacer(content, "a b")]).toEqual([])
      const started = performance.now()
      expect(() => replace(content, "a b", "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(1_000)
    const small = measure(8_000)
    const large = measure(16_000)

    expect(large).toBeLessThan(small * 3 + 100)
  })

  test("preserves A-B-A order when duplicated singles surround a later unique candidate", () => {
    const variants = Array.from({ length: 128 }, (_, index) => {
      const whitespace = index.toString(2).padStart(16, "0").replaceAll("0", " ").replaceAll("1", "\t")
      return `a${whitespace}b`
    })
    const unique = "a\u2003b"
    const content = [...variants, unique, ...variants].join("\n")

    expect([...LineTrimmedReplacer(content, "a b")]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(content, "a b")]).toEqual([...variants, unique, ...variants])
    expect(replace(content, "a b", "changed")).toBe([...variants, "changed", ...variants].join("\n"))
  })

  test("checks an apparently singleton candidate for an unaligned literal duplicate", () => {
    const variants = Array.from({ length: 128 }, (_, index) => {
      const whitespace = index.toString(2).padStart(16, "0").replaceAll("0", " ").replaceAll("1", "\t")
      return `a${whitespace}b`
    })
    const unique = "a\u2003b"
    const hidden = `${variants[0]} prefix ${unique} suffix`
    const content = [...variants, unique, ...variants, hidden].join("\n")
    const candidates = [...WhitespaceNormalizedReplacer(content, "a b")]

    expect(candidates.filter((candidate) => candidate === unique)).toHaveLength(1)
    expect(content.indexOf(unique)).not.toBe(content.lastIndexOf(unique))
    expect(() => replace(content, "a b", "changed")).toThrow(multipleMatchError)
  })

  test("returns an early single-line match without materializing later multiline spans", () => {
    const measure = (lines: number) => {
      const generator = WhitespaceNormalizedReplacer(
        `prefix alpha   beta suffix\n${repeatedLines(lines, "\u2003 tail\tvalue ")}`,
        "alpha\nbeta",
      )
      const started = performance.now()
      const first = generator.next()
      generator.return()
      return { elapsed: performance.now() - started, first }
    }
    measure(100_000)
    const small = measure(500_000)
    const large = measure(1_000_000)

    expect(small.first).toEqual({ value: "alpha   beta", done: false })
    expect(large.first).toEqual({ value: "alpha   beta", done: false })
    expect(large.elapsed).toBeLessThan(small.elapsed * 3 + 75)

    expect(replace("prefix alpha   beta suffix\ntail", "alpha\nbeta", "changed")).toBe("prefix changed suffix\ntail")
  })
})

describe("remaining fuzzy replacer compatibility", () => {
  test("preserves indentation candidates across CRLF and blank lines", () => {
    expect([...IndentationFlexibleReplacer("head\r\n\talpha\r\n\t  beta", "  alpha\r\n    beta")]).toEqual([
      "\talpha\r\n\t  beta",
    ])
    expect([...IndentationFlexibleReplacer("head\n\talpha\n   \n\t  beta\nfoot", "  alpha\n   \n    beta")]).toEqual([
      "\talpha\n   \n\t  beta",
    ])
  })

  test("keeps indentation matches subsumed by line-trimmed matching", () => {
    let state = 0x1ade4710
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]
    const atoms = ["", "alpha", " beta ", "\t\u03b3", " ", "\u2003x", "same"] as const

    for (let iteration = 0; iteration < 1_000; iteration++) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(atoms))
      const content = lines.join(random() < 0.5 ? "\n" : "\r\n") + (random() < 0.25 ? "\n" : "")
      const find =
        Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(atoms)).join(random() < 0.5 ? "\n" : "\r\n") +
        (random() < 0.25 ? "\n" : "")
      const indentation = [...IndentationFlexibleReplacer(content, find)]
      expect({ iteration, candidates: indentation }).toEqual({
        iteration,
        candidates: legacyIndentationFlexibleCandidates(content, find),
      })
      if (indentation.length > 0) expect([...LineTrimmedReplacer(content, find)].length).toBeGreaterThan(0)
    }
  })

  test("preserves escaped candidates, duplicates, and physical-newline slash runs", () => {
    const actual = "actual\tvalue"
    const escaped = String.raw`actual\tvalue`
    expect([...EscapeNormalizedReplacer([actual, escaped, actual].join("\n"), escaped)]).toEqual([
      actual,
      actual,
      escaped,
      actual,
    ])

    const odd = `A${"\\".repeat(3)}\nB`
    const even = `A${"\\".repeat(2)}\nB`
    expect([...EscapeNormalizedReplacer(odd, even)]).toEqual([odd])
    expect([...EscapeNormalizedReplacer(even, even)]).toEqual([even])
  })

  test("replaces a literal escaped candidate only after earlier tiers miss", () => {
    const content = `head\n${String.raw`value\twith\t tabs`}\nfoot`
    const find = "value\twith\t tabs"
    expect([...LineTrimmedReplacer(content, find)]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(content, find)]).toEqual([])
    expect([...EscapeNormalizedReplacer(content, find)]).toEqual([String.raw`value\twith\t tabs`])
    expect(replace(content, find, "changed")).toBe("head\nchanged\nfoot")
  })

  test("preserves trimmed-boundary candidates and its reachable direct fallback", () => {
    expect([...TrimmedBoundaryReplacer(" x \n\tx\t\nend", " x ")]).toEqual(["x", " x ", "\tx\t"])

    const content = "a\na  b"
    const find = "a\na \n"
    expect([...LineTrimmedReplacer(content, find)]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(content, find)]).toEqual([])
    expect([...TrimmedBoundaryReplacer(content, find)]).toEqual(["a\na"])
    expect(replace(content, find, "changed")).toBe("changed  b")
  })

  test("preserves context threshold, CRLF output, empty middles, and greedy anchors", () => {
    expect([
      ...ContextAwareReplacer("A\r\nmatch\r\nwrong\r\nZ\r\nA\r\nno\r\nwrong\r\nZ\r", "A\nmatch\nexpected\nZ\n"),
    ]).toEqual(["A\r\nmatch\r\nwrong\r\nZ\r"])
    expect([...ContextAwareReplacer("A\n  \n\t\nZ", "A\n\n\nZ")]).toEqual(["A\n  \n\t\nZ"])
    expect([...ContextAwareReplacer("A\nx\nZ\nZ", "A\nx\ny\nZ")]).toEqual([])
    expect([...ContextAwareReplacer("A\nZ\nA\nZ", "A\nZ\n")]).toEqual([])
  })

  test("replaces the first context candidate at the historical half-match threshold", () => {
    const actual = `start\nok\n${"z".repeat(500)}\nend`
    const find = `start\nok\n${"a".repeat(500)}\nend`
    expect([...LineTrimmedReplacer(actual, find)]).toEqual([])
    expect([...ContextAwareReplacer(actual, find)]).toEqual([actual])
    expect(replace(actual, find, "changed")).toBe("changed")
  })

  test("matches all exported legacy implementations across fixed-seed randomized inputs", () => {
    let state = 0xf022beef
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]
    const atoms = [
      "",
      "alpha",
      " beta ",
      "\t\u03b3\u00a0",
      "start",
      "end",
      String.raw`a\tb`,
      String.raw`quote\"`,
      "\\",
      "\\\\",
    ] as const

    for (let iteration = 0; iteration < 300; iteration++) {
      const content =
        Array.from({ length: 1 + Math.floor(random() * 9) }, () => pick(atoms)).join(random() < 0.5 ? "\n" : "\r\n") +
        (random() < 0.25 ? "\n" : "")
      const find =
        Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(atoms)).join(random() < 0.5 ? "\n" : "\r\n") +
        (random() < 0.25 ? "\n" : "")
      const actual = {
        indentation: [...IndentationFlexibleReplacer(content, find)],
        escaped: [...EscapeNormalizedReplacer(content, find)],
        trimmed: [...TrimmedBoundaryReplacer(content, find)],
        context: [...ContextAwareReplacer(content, find)],
      }
      expect({ iteration, candidates: actual }).toEqual({
        iteration,
        candidates: {
          indentation: legacyIndentationFlexibleCandidates(content, find),
          escaped: legacyEscapeNormalizedCandidates(content, find),
          trimmed: legacyTrimmedBoundaryCandidates(content, find),
          context: legacyContextAwareCandidates(content, find),
        },
      })
    }
  })

  test("scales near-linearly for long escaped windows that do not match", () => {
    const measure = (lines: number) => {
      const find = `${repeatedLines(lines / 32 - 1, "alpha\tbeta")}\nmissing`
      const started = performance.now()
      const candidates = [...EscapeNormalizedReplacer(repeatedLines(lines, String.raw`alpha\tbeta`), find)]
      return { elapsed: performance.now() - started, candidates }
    }
    measure(2_048)
    const small = measure(16_000)
    const large = measure(32_000)

    expect(small.candidates).toEqual([])
    expect(large.candidates).toEqual([])
    expect(large.elapsed).toBeLessThan(small.elapsed * 3 + 75)
  })

  test("scales near-linearly across odd and even physical-newline slash runs", () => {
    const measure = (lines: number, slashes: number) => {
      const line = "value" + "\\".repeat(slashes)
      const find = repeatedLines(lines / 16 - 1, line) + "\nmissing"
      const started = performance.now()
      const candidates = [...EscapeNormalizedReplacer(repeatedLines(lines, line), find)]
      return { elapsed: performance.now() - started, candidates }
    }
    measure(1_024, 1)
    measure(1_024, 2)
    const oddSmall = measure(8_000, 1)
    const oddLarge = measure(16_000, 1)
    const evenSmall = measure(8_000, 2)
    const evenLarge = measure(16_000, 2)

    expect(oddSmall.candidates).toEqual([])
    expect(oddLarge.candidates).toEqual([])
    expect(evenSmall.candidates).toEqual([])
    expect(evenLarge.candidates).toEqual([])
    expect(oddLarge.elapsed).toBeLessThan(oddSmall.elapsed * 3 + 75)
    expect(evenLarge.elapsed).toBeLessThan(evenSmall.elapsed * 3 + 75)
  })

  test("returns an escaped direct match without splitting a dense multiline tail", () => {
    const find = "direct\\tvalue"
    const target = "direct\tvalue"
    const measure = (content: string) => {
      const generator = EscapeNormalizedReplacer(content, find)
      const started = performance.now()
      const first = generator.next()
      generator.return()
      return { elapsed: performance.now() - started, first }
    }
    const flat = measure(target + "x".repeat(4_000_000))
    const dense = measure(target + "\nx".repeat(2_000_000))

    expect(flat.first).toEqual({ value: target, done: false })
    expect(dense.first).toEqual({ value: target, done: false })
    expect(dense.elapsed).toBeLessThan(flat.elapsed * 3 + 75)
  })
})

describe("edit replacement candidate deduplication", () => {
  test("terminates exact ambiguity before fuzzy candidates", () => {
    expect(() => replace("  x  \n  x  ", "x", "changed")).toThrow(multipleMatchError)
    expect(() => replace("x\nprefix x", "x", "changed")).toThrow(multipleMatchError)

    const exact = "a b\nc"
    const fuzzy = "a\nb c"
    const content = [exact, "stop", exact, "stop", fuzzy].join("\n")
    expect(() => replace(content, exact, "changed")).toThrow(multipleMatchError)
    expect(replace(content, exact, "changed", true)).toBe(["changed", "stop", "changed", "stop", fuzzy].join("\n"))
  })

  test("keeps fallback candidate order when the literal old string is absent", () => {
    const find = "\u2003x\u2003"
    expect(replace("\tx\t\n  x  ", find, "changed")).toBe("changed\n  x  ")
    expect(replace("  x  \n  x  \n\tx\t", find, "changed")).toBe("  x  \n  x  \nchanged")
  })

  test("terminates line-trimmed ambiguity before a later fuzzy singleton", () => {
    const repeated = " a b \n c "
    const fuzzy = "a\nb c"
    const content = [repeated, "stop", repeated, "stop", fuzzy].join("\n")
    const find = "a b\nc"

    expect([...LineTrimmedReplacer(content, find)]).toEqual([repeated, repeated])
    expect([...WhitespaceNormalizedReplacer(content, find)]).toEqual([repeated, repeated, fuzzy])
    expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
  })

  test("terminates whitespace ambiguity before a later escape singleton", () => {
    const repeated = String.raw`foo   \t    bar`
    const escapedSingleton = "foo \t bar"
    const find = String.raw`foo \t bar`
    const content = [repeated, repeated, escapedSingleton].join("\n")

    expect([...LineTrimmedReplacer(content, find)]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(content, find)]).toEqual([repeated, repeated])
    expect([...EscapeNormalizedReplacer(content, find)]).toEqual([escapedSingleton, escapedSingleton])
    expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
  })

  test("terminates escape ambiguity before a later trimmed-boundary singleton", () => {
    const find = " A\\t\nB \n"
    const repeated = " A\t\nB \n"
    const trimmedSingleton = "A\\t\nB"
    const content = [" A\t", "B ", "", "STOP", " A\t", "B ", "", "STOP", "A\\t", "B suffix"].join("\n")

    expect([...LineTrimmedReplacer(content, find)]).toEqual([])
    expect([...WhitespaceNormalizedReplacer(content, find)]).toEqual([])
    expect([...EscapeNormalizedReplacer(content, find)]).toEqual([repeated, repeated, repeated])
    expect([...TrimmedBoundaryReplacer(content, find)]).toEqual([trimmedSingleton])
    expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
  })

  test("preserves A-B-A multiline group order and replaces the first unique group", () => {
    const repeated = " x \n y "
    const unique = "\tx\t\n\ty\t"
    const content = [repeated, "stop", unique, "stop", repeated].join("\n")

    expect([...LineTrimmedReplacer(content, "x\ny")]).toEqual([repeated, unique, repeated])
    expect(replace(content, "x\ny", "changed")).toBe([repeated, "stop", "changed", "stop", repeated].join("\n"))
  })

  test("checks unaligned literal duplicates for singleton ranked groups", () => {
    const repeated = " a \n b "
    const singleton = "\ta\t\n\tb\t"
    const content = [repeated, "stop", repeated, "stop", singleton, "stop", "prefix\ta\t\n\tb\tsuffix"].join("\n")

    expect([...LineTrimmedReplacer(content, "a\nb")]).toEqual([repeated, repeated, singleton])
    expect(() => replace(content, "a\nb", "changed")).toThrow(multipleMatchError)
  })

  test("checks later duplicate groups for disproportionate whitespace in insertion order", () => {
    const repeated = " a \n b "
    const disproportionate = `a\n${" ".repeat(600)}b`
    const content = [repeated, "stop", repeated, "stop", disproportionate, "stop", disproportionate].join("\n")

    expect([...LineTrimmedReplacer(content, "a\nb")]).toEqual([repeated, repeated, disproportionate, disproportionate])
    expect(() => replace(content, "a\nb", "changed")).toThrow(
      "Refusing replacement because the matched span is much larger than oldString",
    )
  })

  test("preserves proportionate CRLF blank-line groups with a trailing search newline", () => {
    const repeated = " a \r\n \r\n b \r"
    const unique = "\ta\t\r\n\r\n\tb\t\r"
    const content = `${repeated}\nstop\r\n${repeated}\nstop\r\n${unique}\nend`
    const find = "a\n\nb\n"

    expect([...LineTrimmedReplacer(content, find)]).toEqual([repeated, repeated, unique])
    expect(replace(content, find, "changed\r")).toBe(`${repeated}\nstop\r\n${repeated}\nstop\r\nchanged\r\nend`)
  })

  test("preserves replace-all and disproportionate-match checks for repeated candidates", () => {
    expect(replace("  needle  \n  needle  ", "\tneedle\t", "changed", true)).toBe("changed\nchanged")

    const disproportionate = `a\n${" ".repeat(600)}b\na\n${" ".repeat(600)}b`
    const message = "Refusing replacement because the matched span is much larger than oldString"
    expect(() => replace(disproportionate, "a\nb", "changed")).toThrow(message)
    expect(() => replace(disproportionate, "a\nb", "changed", true)).toThrow(message)
  })

  test("returns an early unique match without draining later replacers", () => {
    const content = `unique-token\n${repeatedLines(256_000, "suffix")}`
    const started = performance.now()
    const result = replace(content, "unique-token", "changed")

    expect(result.startsWith("changed\nsuffix")).toBe(true)
    expect(result.length).toBe(content.length - "unique-token".length + "changed".length)
    expect(performance.now() - started).toBeLessThan(250)
  })

  test("scales near-linearly for repeated ambiguous candidates", () => {
    const measure = (lines: number) => {
      const content = repeatedLines(lines, "  needle  ")
      const started = performance.now()
      expect(() => replace(content, "\tneedle\t", "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(2_048)
    const small = measure(32_000)
    const large = measure(64_000)

    expect(large).toBeLessThan(small * 3 + 75)
  })

  test("short-circuits raw-exact multiline ambiguity before fuzzy scans", () => {
    const measure = (lines: number, window: number) => {
      const content = repeatedLines(lines, "same")
      const find = repeatedLines(window, "same")
      const started = performance.now()
      expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(1_024, 256)
    const small = measure(8_000, 2_000)
    const large = measure(16_000, 4_000)

    expect(large).toBeLessThan(small * 3 + 50)
    expect(large).toBeLessThan(500)
  })

  test("short-circuits multiline line-trimmed ambiguity before fuzzy scans", () => {
    const measure = (lines: number, window: number) => {
      const content = repeatedLines(lines, " x ")
      const find = repeatedLines(window, "x")
      const started = performance.now()
      expect(() => replace(content, find, "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(1_000, 250)
    const small = measure(4_000, 1_000)
    const large = measure(8_000, 2_000)

    expect(large).toBeLessThan(small * 3 + 50)
    expect(large).toBeLessThan(500)
  })

  test("scales near-linearly for distinct aligned duplicate candidates", () => {
    const measure = (lines: number) => {
      const content = distinctRepeatedTrimmedLines(lines)
      const started = performance.now()
      expect(() => replace(content, "\u2003needle\u2003", "changed")).toThrow(multipleMatchError)
      return performance.now() - started
    }
    measure(1_000)
    const small = measure(4_000)
    const large = measure(8_000)

    expect(large).toBeLessThan(small * 3 + 75)
  })

  test("scales near-linearly for large overlapping multiline groups followed by a singleton", () => {
    const measure = (window: number) => {
      const token = "x".repeat(16)
      const repeated = ` ${token} `
      const unique = `\t${token}\t`
      const content = `${repeatedLines(window * 2, repeated)}\n${unique}`
      const find = repeatedLines(window, token)
      const started = performance.now()
      const result = replace(content, find, "changed")
      const elapsed = performance.now() - started

      expect(result).toBe(`${repeatedLines(window + 1, repeated)}\nchanged`)
      return elapsed
    }
    measure(512)
    const small = measure(4_096)
    const large = measure(8_192)

    expect(large).toBeLessThan(small * 3 + 75)
  })
})

describe("edit replacer bounds", () => {
  it.live("does not rescan the full file for repeated anchors", () =>
    Effect.sync(() => {
      const content = Array.from({ length: 16_000 }, () => "start").join("\n")
      const started = performance.now()
      expect([...BlockAnchorReplacer(content, "start\nmiddle\nmissing")]).toEqual([])
      expect([...ContextAwareReplacer(content, "start\nmiddle\nmissing")]).toEqual([])
      expect(performance.now() - started).toBeLessThan(1_000)
    }),
  )

  test("allows exactly the fuzzy line-comparison budget and rejects one more", () => {
    const scenario = (middleLines: number) => ({
      content: `start\n${repeatedLines(middleLines, "a")}\nend`,
      find: `start\n${repeatedLines(middleLines, "b")}\nend`,
    })
    const allowed = scenario(250_000)
    const rejected = scenario(250_001)

    expect([...BlockAnchorReplacer(allowed.content, allowed.find)]).toEqual([])
    expect(() => [...BlockAnchorReplacer(rejected.content, rejected.find)]).toThrow(fuzzySearchError)
  })

  test("applies the exact fuzzy line-comparison boundary to context matching", () => {
    const scenario = (middleLines: number) => ({
      content: `start\n${repeatedLines(middleLines, "a")}\nend`,
      find: `start\n${repeatedLines(middleLines, "b")}\nend`,
    })
    const allowed = scenario(250_000)
    const rejected = scenario(250_001)

    expect([...ContextAwareReplacer(allowed.content, allowed.find)]).toEqual([])
    expect(() => [...ContextAwareReplacer(rejected.content, rejected.find)]).toThrow(fuzzySearchError)
  })

  test("allows exactly the Levenshtein-cell budget and rejects one more", () => {
    const contentLine = "a".repeat(2_000)
    const searchLine = `${"a".repeat(1_999)}b`
    const allowed = `start\n${contentLine}\nend`

    expect([...BlockAnchorReplacer(allowed, `start\n${searchLine}\nend`)]).toEqual([allowed])
    expect(() =>
      Array.from(BlockAnchorReplacer(`start\n${contentLine}\nx\nend`, `start\n${searchLine}\ny\nend`)),
    ).toThrow(fuzzySearchError)

    const equal = `start\n${"same".repeat(4_000)}\nend`
    expect([...BlockAnchorReplacer(equal, equal)]).toEqual([equal])
  })
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.filediff.patch).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces a line-trimmed Unicode block through the edit tool", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unicode.txt")
        yield* put(filepath, "header\n  cafe\u0301 🧪  \n\t東京 ✨\nfooter\n")

        const result = yield* run({
          filePath: filepath,
          oldString: "cafe\u0301 🧪\n東京 ✨",
          newString: "updated\nblock",
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* loadRaw(filepath)).toBe("header\nupdated\nblock\nfooter\n")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.filediff.patch).toContain("-using System;")
        expect(result.metadata.filediff.patch).toContain("+using Up;")
        expect(result.metadata.filediff.patch).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("leaves the file unchanged when fuzzy matching exceeds its safety budget", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fuzzy-budget.txt")
        const contentLine = "a".repeat(2_000)
        const original = `start\n${contentLine}\nx\nend`
        yield* put(filepath, original)

        const error = yield* fail({
          filePath: filepath,
          oldString: `start\n${"a".repeat(1_999)}b\ny\nend`,
          newString: "changed",
        })

        expect(error.message).toBe(fuzzySearchError)
        expect(yield* loadRaw(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )

    it.instance("keeps permission metadata separate from canonical edit metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "metadata.txt")
        const permissions: Parameters<Tool.Context["ask"]>[0][] = []
        const updates: Parameters<Tool.Context["metadata"]>[0][] = []
        yield* put(filepath, "old\n")

        const result = yield* run(
          { filePath: filepath, oldString: "old", newString: "new" },
          {
            ...ctx,
            ask: (input) =>
              Effect.sync(() => {
                permissions.push(input)
              }),
            metadata: (input) =>
              Effect.sync(() => {
                updates.push(input)
              }),
          },
        )

        expect(permissions).toHaveLength(1)
        expect(Object.keys(permissions[0].metadata).sort()).toEqual(["diff", "filepath"])
        expect(permissions[0].metadata).toEqual({
          filepath,
          diff: expect.stringContaining("+new"),
        })
        expect(updates).toEqual([
          {
            metadata: {
              filediff: result.metadata.filediff,
              diagnostics: {},
            },
          },
        ])
        expect(result.metadata).not.toHaveProperty("diff")
        expect(result.metadata).toMatchObject({ diagnostics: {}, filediff: result.metadata.filediff })
      }),
    )

    it.instance(
      "reports formatter changes in the canonical edit patch after permission",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.payload")
          const permissions: Parameters<Tool.Context["ask"]>[0][] = []
          yield* put(filepath, "old\n")

          const result = yield* run(
            { filePath: filepath, oldString: "old", newString: "new" },
            {
              ...ctx,
              ask: (input) =>
                Effect.sync(() => {
                  permissions.push(input)
                }),
            },
          )

          expect(permissions[0].metadata.diff).not.toContain("formatter-only")
          expect(result.metadata.filediff.patch).toContain("formatter-only")
          expect(yield* load(filepath)).toBe("new\nformatter-only\n")
        }),
      {
        config: {
          formatter: {
            append: {
              extensions: [".payload"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; fs.appendFileSync(file, 'formatter-only\\n')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("serializes one copy of a large canonical edit patch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "large.txt")
        const marker = `PATCH_PAYLOAD_${"x".repeat(128 * 1024)}`
        yield* put(filepath, "old\n")

        const result = yield* run({ filePath: filepath, oldString: "old", newString: marker })
        const serialized = JSON.stringify(result.metadata)

        expect(result.metadata).not.toHaveProperty("diff")
        expect(serialized.split(marker)).toHaveLength(2)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})
