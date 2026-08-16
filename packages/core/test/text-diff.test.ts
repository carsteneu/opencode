import { describe, expect, test } from "bun:test"
import { TextDiff } from "../src/text-diff"
import { applyPatch } from "diff"

describe("TextDiff", () => {
  test("builds a patch and counts changes in one result", () => {
    const result = TextDiff.create("src/a.ts", "src/a.ts", "one\ntwo\nthree\n", "one\nchanged\nadded\nthree\n")

    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(1)
    expect(result.coarse).toBeFalse()
    expect(result.patch).toContain("@@ -1,3 +1,4 @@")
    expect(result.patch).toContain("-two")
    expect(result.patch).toContain("+changed")
    expect(result.patch).toContain("+added")
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
