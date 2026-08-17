import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EditTool,
  LineTrimmedReplacer,
  replace,
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

  it.live("compares long candidate lines without a quadratic allocation", () =>
    Effect.sync(() => {
      const content = `start\n${"a".repeat(4_000)}\nend`
      const search = `start\n${"b".repeat(4_000)}\nend`
      expect([...BlockAnchorReplacer(content, search)]).toEqual([])
    }),
  )
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

        expect(result.metadata.diff).toContain("new content")
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

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

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
