import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch, parsePatch } from "diff"
import { fileDiff } from "@opencode/core/tool/plugin/file-diff"
import { emptyPatch } from "@opencode/core/vcs/patch"

const hunks = (patch: string) => parsePatch(patch)[0]?.hunks ?? []

describe("fileDiff", () => {
  test("matches the previous two-file patch for a bounded diff", () => {
    const before = "alpha\nbeta\ngamma\n"
    const after = "alpha\nBETA\ngamma\ndelta\n"
    const diff = fileDiff("file.txt", before, after)
    expect(diff.patch).toBe(createTwoFilesPatch("file.txt", "file.txt", before, after))
    expect(diff).toMatchObject({ file: "file.txt", status: "modified", additions: 2, deletions: 1 })
    expect(hunks(diff.patch).length).toBeGreaterThan(0)
  })

  test("keeps counts and status for an added file", () => {
    const diff = fileDiff("new.txt", "", "one\ntwo\n", "added")
    expect(diff).toMatchObject({ file: "new.txt", status: "added", additions: 2, deletions: 0 })
    expect(hunks(diff.patch).length).toBeGreaterThan(0)
  })

  test("degrades to a bounded patch when the input exceeds the line budget", () => {
    const lines = Array.from({ length: 200_000 }, (_, index) => `line ${index}`)
    const before = lines.join("\n") + "\n"
    const after = lines.map((line) => line.replace("line", "changed")).join("\n") + "\n"
    const diff = fileDiff("huge.txt", before, after)
    // 4 MiB of code units would also trip here; 200k lines trips the 128 Ki line budget first.
    expect(diff.patch).toBe(emptyPatch("huge.txt"))
    expect(hunks(diff.patch)).toEqual([])
    expect(diff).toMatchObject({ file: "huge.txt", status: "modified", additions: 200_000, deletions: 200_000 })
  })

  test("degrades to a bounded patch when the output exceeds the byte budget", () => {
    const lines = Array.from({ length: 40_000 }, (_, index) => `before ${index}`)
    const before = lines.join("\n") + "\n"
    const after = lines.map((line) => line.replace("before", "after-change")).join("\n") + "\n"
    const diff = fileDiff("wide.txt", before, after)
    // Input stays under 4 MiB / 128 Ki lines, but the unified patch is well over 256 KiB.
    expect(diff.patch).toBe(emptyPatch("wide.txt"))
    expect(hunks(diff.patch)).toEqual([])
    expect(diff.additions).toBe(40_000)
    expect(diff.deletions).toBe(40_000)
  })
})
