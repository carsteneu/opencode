import { describe, expect, test } from "bun:test"
import { TextDiff } from "../src/text-diff"
import { applyPatch } from "diff"

describe("TextDiff", () => {
  test("keeps the legacy small patch byte-identical", () => {
    const result = TextDiff.create("src/a.ts", "src/a.ts", "one\ntwo\nthree\n", "one\nchanged\nadded\nthree\n")

    expect(result).toEqual({
      patch:
        "Index: src/a.ts\n===================================================================\n--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,4 @@\n one\n-two\n+changed\n+added\n three\n",
      additions: 2,
      deletions: 1,
      coarse: false,
    })
  })

  test("matches legacy patches across text and filename edge cases", () => {
    const cases = [
      ["src/lf.ts", "src/lf.ts", "one\ntwo\n", "one\nchanged\n"],
      ["src/crlf.ts", "src/crlf.ts", "one\r\ntwo\r\n", "one\r\nchanged\r\n"],
      ["src/no-final.ts", "src/no-final.ts", "one\ntwo", "one\nchanged"],
      ["src/empty.ts", "src/empty.ts", "", "created"],
      [
        "src/multiple.ts",
        "src/multiple.ts",
        `old first\n${"same\n".repeat(10)}old last\n`,
        `new first\n${"same\n".repeat(10)}new last\n`,
      ],
      ['src/"old😀\ud800.ts', "src/\\newé\udc00.ts", "old 😀\ud800\n", "new €\udc00\n"],
    ] as const

    for (const [oldFile, newFile, before, after] of cases) {
      const legacy = TextDiff.create(oldFile, newFile, before, after)
      const serializedBytes = Buffer.byteLength(JSON.stringify(legacy.patch))
      expect(
        TextDiff.createBounded(oldFile, newFile, before, after, {
          maxSerializedPatchBytes: serializedBytes,
        }),
      ).toEqual({
        patch: legacy.patch,
        serializedBytes,
        additions: legacy.additions,
        deletions: legacy.deletions,
      })
    }
  })

  test("retains an exact JSON-byte cap and omits the patch one byte over", () => {
    const oldFile = 'src/"old😀\ud800.ts'
    const newFile = "src/\\newé\udc00.ts"
    const before = "old \\ \t \u0000 😀\ud800\n"
    const after = 'new " \b \u001f €\udc00\n'
    const legacy = TextDiff.create(oldFile, newFile, before, after)
    const serializedBytes = Buffer.byteLength(JSON.stringify(legacy.patch))

    expect(
      TextDiff.createBounded(oldFile, newFile, before, after, {
        maxSerializedPatchBytes: serializedBytes,
      }),
    ).toEqual({
      patch: legacy.patch,
      serializedBytes,
      additions: legacy.additions,
      deletions: legacy.deletions,
    })
    expect(
      TextDiff.createBounded(oldFile, newFile, before, after, {
        maxSerializedPatchBytes: serializedBytes - 1,
      }),
    ).toEqual({
      serializedBytes,
      additions: legacy.additions,
      deletions: legacy.deletions,
    })
  })

  test("matches explicit edit-length behavior for empty, single-line, and final-newline changes", () => {
    const cases = [
      ["", "x"],
      ["x", "y"],
      ["x", "x\n"],
      ["", "\n"],
      ["\n", ""],
    ] as const

    for (const maxEditLength of [0, 1, 2]) {
      for (const [before, after] of cases) {
        const legacy = TextDiff.create("edge", "edge", before, after, { maxEditLength })
        const serializedBytes = Buffer.byteLength(JSON.stringify(legacy.patch))
        expect(
          TextDiff.createBounded("edge", "edge", before, after, {
            maxSerializedPatchBytes: serializedBytes,
            maxEditLength,
          }),
        ).toEqual({
          patch: legacy.patch,
          serializedBytes,
          additions: legacy.additions,
          deletions: legacy.deletions,
        })
      }
    }
  })

  test("counts files without a trailing newline", () => {
    const result = TextDiff.create("empty", "empty", "", "value")

    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(0)
    expect(result.patch).toContain("\\ No newline at end of file")
  })

  test("falls back to a valid linear full-file patch when exact diffing exceeds its budget", () => {
    const before = "old one\nold two"
    const after = "new one\nnew two\nnew three"
    const result = TextDiff.create("src/a.ts", "src/a.ts", before, after, { maxEditLength: 0 })

    expect(result.coarse).toBeTrue()
    expect(result.additions).toBe(3)
    expect(result.deletions).toBe(2)
    expect(result.patch).toContain("coarse diff after calculation limit")
    expect(applyPatch(before, result.patch)).toBe(after)

    const serializedBytes = Buffer.byteLength(JSON.stringify(result.patch))
    expect(
      TextDiff.createBounded("src/a.ts", "src/a.ts", before, after, {
        maxSerializedPatchBytes: serializedBytes,
        maxEditLength: 0,
      }),
    ).toEqual({
      patch: result.patch,
      serializedBytes,
      additions: result.additions,
      deletions: result.deletions,
    })
    expect(
      TextDiff.createBounded("src/a.ts", "src/a.ts", before, after, {
        maxSerializedPatchBytes: serializedBytes - 1,
        maxEditLength: 0,
      }),
    ).toEqual({
      serializedBytes,
      additions: result.additions,
      deletions: result.deletions,
    })
  })

  test("bounds huge exact single-line and forced-coarse multiline patches while retaining statistics", () => {
    const maximum = 256 * 1024
    const single = TextDiff.createBounded(
      "single.txt",
      "single.txt",
      `old ${"a".repeat(300 * 1024)}`,
      `new ${"b".repeat(300 * 1024)}`,
      { maxSerializedPatchBytes: maximum },
    )
    expect(single).toEqual({ serializedBytes: maximum + 1, additions: 1, deletions: 1 })

    const lines = 80_000
    const multiline = TextDiff.createBounded(
      "multiline.txt",
      "multiline.txt",
      "old\n".repeat(lines),
      "new\n".repeat(lines),
      { maxSerializedPatchBytes: maximum, maxEditLength: 0 },
    )
    expect(multiline).toEqual({ serializedBytes: maximum + 1, additions: lines, deletions: lines })
  })

  test("retains a small exact patch for sparse edits in a large file", () => {
    const middle = "same\n".repeat(60_000)
    const before = `old first\n${middle}old last\n`
    const after = `new first\n${middle}new last\n`
    const result = TextDiff.createBounded("sparse.ts", "sparse.ts", before, after, {
      maxSerializedPatchBytes: 256 * 1024,
    })

    expect(result.patch).toBeDefined()
    expect(result.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(result.patch)))
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(2)
    expect(applyPatch(before, result.patch!)).toBe(after)
  })

  test("builds a coarse patch for very high line counts without argument-list expansion", () => {
    const before = "a\n".repeat(125_000)
    const after = "b\n".repeat(125_000)
    const result = TextDiff.create("src/a.ts", "src/a.ts", before, after)

    expect(result.coarse).toBeTrue()
    expect(result.additions).toBe(125_000)
    expect(result.deletions).toBe(125_000)
    expect(result.patch.startsWith("Index: src/a.ts\n")).toBeTrue()
    expect(result.patch.endsWith("+b\n")).toBeTrue()
  })

  test("keeps large linear appends exact instead of expanding them into a full-file replacement", () => {
    const before = Array.from({ length: 110_000 }, (_, index) => `existing ${index}`).join("\n") + "\n"
    const after = before + "added\n"
    const result = TextDiff.create("src/a.ts", "src/a.ts", before, after)

    expect(result.coarse).toBeFalse()
    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(0)
    expect(result.patch.length).toBeLessThan(1_000)
  })

  test("keeps sparse edge edits exact in very high-line-count files", () => {
    const middle = "same\n".repeat(259_998)
    const before = `old first\n${middle}old last\n`
    const after = `new first\n${middle}new last\n`
    const result = TextDiff.create("src/a.ts", "src/a.ts", before, after)

    expect(result.coarse).toBeFalse()
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(2)
    expect(result.patch.length).toBeLessThan(1_000)
  })
})
