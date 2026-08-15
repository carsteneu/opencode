import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
  DIFF_PREVIEW_LIMITS,
  createDiffPreview,
  formatDiffBytes,
  measureDiff,
  shouldLimitDiffSet,
} from "../../src/util/diff-preview"

describe("createDiffPreview", () => {
  test("measures a small diff without changing its contents", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
-before
+after
 context`

    expect(createDiffPreview(diff)).toEqual({
      bytes: Buffer.byteLength(diff),
      additions: 1,
      deletions: 1,
      changedLines: 2,
      totalLines: 7,
      limited: false,
      preview: diff,
    })
  })

  test("limits only after the patch byte threshold", () => {
    const exact = "x".repeat(DIFF_PREVIEW_LIMITS.maxPatchBytes)
    const over = exact + "x"

    expect(createDiffPreview(exact).limited).toBe(false)
    expect(createDiffPreview(over)).toMatchObject({
      bytes: DIFF_PREVIEW_LIMITS.maxPatchBytes + 1,
      limited: true,
    })
  })

  test("limits after 500 changed lines without depending on long lines", () => {
    const exact = `--- a/file.ts
+++ b/file.ts
@@ -0,0 +1,${DIFF_PREVIEW_LIMITS.maxChangedLines} @@
${"+x\n".repeat(DIFF_PREVIEW_LIMITS.maxChangedLines)}`
    const over = `--- a/file.ts
+++ b/file.ts
@@ -0,0 +1,${DIFF_PREVIEW_LIMITS.maxChangedLines + 1} @@
${"+x\n".repeat(DIFF_PREVIEW_LIMITS.maxChangedLines + 1)}`

    expect(createDiffPreview(exact)).toMatchObject({
      additions: DIFF_PREVIEW_LIMITS.maxChangedLines,
      changedLines: DIFF_PREVIEW_LIMITS.maxChangedLines,
      limited: false,
    })
    expect(createDiffPreview(over)).toMatchObject({
      additions: DIFF_PREVIEW_LIMITS.maxChangedLines + 1,
      changedLines: DIFF_PREVIEW_LIMITS.maxChangedLines + 1,
      limited: true,
    })
  })

  test("counts UTF-8 bytes and preserves complete Unicode characters", () => {
    const diff = "🙂".repeat(30_000)
    const result = createDiffPreview(diff)

    expect(result.bytes).toBe(120_000)
    expect(result.limited).toBe(true)
    expect(Buffer.from(result.preview).toString("utf8")).toBe(result.preview)
    expect(result.preview.length).toBeLessThanOrEqual(DIFF_PREVIEW_LIMITS.maxPreviewCharacters)
  })

  test("counts changed content that resembles file headers", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
--- old
+++ new`

    expect(createDiffPreview(diff)).toMatchObject({ additions: 1, deletions: 1, changedLines: 2 })
  })

  test("does not count adjacent file headers as changed content", () => {
    const patch = (file: string) => `--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-old
+new`

    expect(createDiffPreview(`${patch("one.ts")}\n${patch("two.ts")}`)).toMatchObject({
      additions: 2,
      deletions: 2,
      changedLines: 4,
    })
  })

  test("builds a bounded CRLF head and tail preview without a final newline", () => {
    const diff = Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\r\n")
    const result = createDiffPreview(diff)

    expect(result.totalLines).toBe(60)
    expect(result.preview.startsWith("line-0\r\n")).toBe(true)
    expect(result.preview).toContain("... diff omitted ...")
    expect(result.preview).not.toContain("line-39\r\n")
    expect(result.preview.endsWith("line-59")).toBe(true)
    expect(result.preview.split(/\r?\n/)).toHaveLength(DIFF_PREVIEW_LIMITS.maxPreviewLines)
    expect(result.preview.length).toBeLessThanOrEqual(DIFF_PREVIEW_LIMITS.maxPreviewCharacters)
  })

  test("bounds a single long line by characters", () => {
    const result = createDiffPreview("a".repeat(DIFF_PREVIEW_LIMITS.maxPreviewCharacters * 2))

    expect(result.totalLines).toBe(1)
    expect(result.preview).toContain("... diff omitted ...")
    expect(result.preview.length).toBeLessThanOrEqual(DIFF_PREVIEW_LIMITS.maxPreviewCharacters)
  })
})

test("measureDiff returns only aggregate statistics", () => {
  const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"
  expect(measureDiff(diff)).toEqual({
    bytes: Buffer.byteLength(diff),
    additions: 1,
    deletions: 1,
    changedLines: 2,
    totalLines: 5,
    limited: false,
  })
})

describe("shouldLimitDiffSet", () => {
  test("limits file counts only above the threshold", () => {
    expect(shouldLimitDiffSet(Array(DIFF_PREVIEW_LIMITS.maxSetFiles).fill(undefined))).toBe(false)
    expect(shouldLimitDiffSet(Array(DIFF_PREVIEW_LIMITS.maxSetFiles + 1).fill(undefined))).toBe(true)
    expect(DIFF_PREVIEW_LIMITS.maxFileTreeFiles).toBe(500)
  })

  test("limits aggregate UTF-8 patch bytes only above the threshold", () => {
    const exact = "x".repeat(DIFF_PREVIEW_LIMITS.maxSetBytes)

    expect(shouldLimitDiffSet([exact])).toBe(false)
    expect(shouldLimitDiffSet([exact, "x"])).toBe(true)
    expect(shouldLimitDiffSet(["🙂".repeat(DIFF_PREVIEW_LIMITS.maxSetBytes / 4), undefined])).toBe(false)
  })
})

describe("formatDiffBytes", () => {
  test("formats binary byte units", () => {
    expect(formatDiffBytes(512)).toBe("512 B")
    expect(formatDiffBytes(1536)).toBe("1.5 KiB")
    expect(formatDiffBytes(1024 * 1024)).toBe("1 MiB")
  })
})
