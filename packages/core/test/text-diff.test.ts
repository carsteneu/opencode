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

  test("keeps default single-line patches byte-identical across newline and Unicode edges", () => {
    const cases = [
      ["same", "same", "", "created"],
      ["same", "same", "old", "new"],
      ["same", "same", "value", "value\n"],
      ["same", "same", "old\r\n", "new\r\n"],
      ["same", "same", "old\rvalue", "new\rafter"],
      ['old/"😀\ud800', "new/\\é\udc00", "old \u0000😀\ud800", "new \u001f€\udc00"],
    ] as const

    cases.forEach(([oldFile, newFile, before, after]) => {
      const legacy = TextDiff.create(oldFile, newFile, before, after)
      const serializedBytes = Buffer.byteLength(JSON.stringify(legacy.patch))

      expect(
        TextDiff.createBounded(oldFile, newFile, before, after, { maxSerializedPatchBytes: serializedBytes }),
      ).toEqual({
        patch: legacy.patch,
        serializedBytes,
        additions: legacy.additions,
        deletions: legacy.deletions,
      })
    })
  })

  test("returns a header-only identity before option and input preflights", () => {
    const file = "same😀\ud800.txt"
    const value = `${"x".repeat(2_100_000)}\n${"same\r\n".repeat(70_000)}`
    const patch = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n`
    const serializedBytes = Buffer.byteLength(JSON.stringify(patch))

    expect(value.length * 2).toBeGreaterThan(4 * 1024 * 1024)
    expect(
      TextDiff.createBounded(file, file, value, value, {
        maxSerializedPatchBytes: serializedBytes,
        timeout: Number.NaN,
        maxEditLength: Number.NaN,
      }),
    ).toEqual({ patch, serializedBytes, additions: 0, deletions: 0 })
    expect(
      TextDiff.createBounded(file, file, value, value, {
        maxSerializedPatchBytes: 0,
        timeout: 0,
        maxEditLength: 0,
      }),
    ).toEqual({ serializedBytes: 1, additions: 0, deletions: 0 })
  })

  test("coarsens changed input deterministically when an explicit calculation budget is exhausted", () => {
    const before = "old\r\nmiddle\r\nlast"
    const after = "new\r\nmiddle\r\nlast!"
    const coarse = TextDiff.create("edge", "edge", before, after, { maxEditLength: 0 })
    const serializedBytes = Buffer.byteLength(JSON.stringify(coarse.patch))
    const options = [
      { timeout: 0 },
      { timeout: -1 },
      { timeout: Number.NaN },
      { maxEditLength: 0 },
      { maxEditLength: -1 },
      { maxEditLength: Number.NaN },
    ]

    expect(coarse.coarse).toBeTrue()
    expect(applyPatch(before, coarse.patch)).toBe(after)
    options.forEach((option) => {
      expect(
        TextDiff.createBounded("edge", "edge", before, after, { maxSerializedPatchBytes: serializedBytes, ...option }),
      ).toEqual({
        patch: coarse.patch,
        serializedBytes,
        additions: coarse.additions,
        deletions: coarse.deletions,
      })
    })
  })

  test("uses full-file statistics without diff tokenization when even the header cannot fit", () => {
    const middle = "same\n".repeat(60_000)
    const before = `old\n${middle}tail\n`
    const after = `new\n${middle}tail\n`

    expect(TextDiff.createBounded("zero.txt", "zero.txt", before, after, { maxSerializedPatchBytes: 0 })).toEqual({
      serializedBytes: 1,
      additions: 60_002,
      deletions: 60_002,
    })
  })

  test("keeps preflight-only huge inputs within a bounded peak-memory multiple", async () => {
    const run = async (body: string) => {
      const module = new URL("../src/text-diff.ts", import.meta.url).href
      const child = Bun.spawn([process.execPath, "-e", `import { TextDiff } from ${JSON.stringify(module)};${body}`], {
        stdout: "ignore",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      if (exitCode !== 0) throw new Error(stderr)
      const usage = child.resourceUsage()
      if (!usage) throw new Error("Missing child process resource usage")
      return usage.maxRSS
    }
    const baseline = await run('TextDiff.createBounded("x", "x", "a\\n", "b\\n", { maxSerializedPatchBytes: 0 })')
    const huge = await run(
      'const middle = "same\\n".repeat(1_000_000);' +
        'TextDiff.createBounded("x", "x", middle, middle, { maxSerializedPatchBytes: 256 * 1024 });' +
        'TextDiff.createBounded("x", "x", "old\\n" + middle, "new\\n" + middle, { maxSerializedPatchBytes: 0 });' +
        'TextDiff.createBounded("x", "x", "old\\n".repeat(1_000_000), "new\\n".repeat(1_000_000), { maxSerializedPatchBytes: 256 * 1024, maxEditLength: 0 });',
    )

    expect(baseline).toBeGreaterThan(0)
    expect(huge).toBeLessThan(baseline * 3)
  })

  test("keeps the exact UTF-16 input boundary and coarsens one code unit over", () => {
    const maximumInput = 4 * 1024 * 1024
    const maximumPatch = 256 * 1024
    const context = "same\n".repeat(10)
    const prefix = "x".repeat(maximumInput / 2 - context.length - "\nold\n".length)
    const before = `${prefix}\n${context}old\n`
    const after = `${prefix}\n${context}new\n`
    const over = `${prefix}\n${context}new!\n`
    const legacy = TextDiff.create("chars.txt", "chars.txt", before, after)
    const exact = TextDiff.createBounded("chars.txt", "chars.txt", before, after, {
      maxSerializedPatchBytes: maximumPatch,
    })

    expect(before.length + after.length).toBe(maximumInput)
    expect(exact).toEqual({
      patch: legacy.patch,
      serializedBytes: Buffer.byteLength(JSON.stringify(legacy.patch)),
      additions: legacy.additions,
      deletions: legacy.deletions,
    })
    expect(applyPatch(before, exact.patch!)).toBe(after)
    expect(before.length + over.length).toBe(maximumInput + 1)
    expect(
      TextDiff.createBounded("chars.txt", "chars.txt", before, over, {
        maxSerializedPatchBytes: maximumPatch,
      }),
    ).toEqual({ serializedBytes: maximumPatch + 1, additions: 12, deletions: 12 })
  })

  test("keeps the exact CRLF line-token boundary and coarsens one no-final-newline token over", () => {
    const maximumLines = 128 * 1024
    const maximumPatch = 256 * 1024
    const middle = "same\r\n".repeat((maximumLines - 4) / 2)
    const before = `old\r\n${middle}tail\r\n`
    const after = `new\r\n${middle}tail\r\n`
    const over = `${after}extra`
    const legacy = TextDiff.create("lines.txt", "lines.txt", before, after)
    const exact = TextDiff.createBounded("lines.txt", "lines.txt", before, after, {
      maxSerializedPatchBytes: maximumPatch,
    })

    expect(exact).toEqual({
      patch: legacy.patch,
      serializedBytes: Buffer.byteLength(JSON.stringify(legacy.patch)),
      additions: legacy.additions,
      deletions: legacy.deletions,
    })
    expect(applyPatch(before, exact.patch!)).toBe(after)
    expect(
      TextDiff.createBounded("lines.txt", "lines.txt", before, over, {
        maxSerializedPatchBytes: maximumPatch,
      }),
    ).toEqual({ serializedBytes: maximumPatch + 1, additions: 65_537, deletions: 65_536 })
  })

  test("matches a sparse CRLF multiline patch with Unicode and no final newline", () => {
    const middle = "same\r\n".repeat(10_000)
    const before = `old 😀\ud800\r\n${middle}tail \ud800`
    const after = `new €\udc00\r\n${middle}tail \udc00`
    const legacy = TextDiff.create("sparse😀\ud800", "sparse😀\ud800", before, after)
    const result = TextDiff.createBounded("sparse😀\ud800", "sparse😀\ud800", before, after, {
      maxSerializedPatchBytes: 256 * 1024,
    })

    expect(result).toEqual({
      patch: legacy.patch,
      serializedBytes: Buffer.byteLength(JSON.stringify(legacy.patch)),
      additions: legacy.additions,
      deletions: legacy.deletions,
    })
    expect(applyPatch(before, result.patch!)).toBe(after)
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

    test("coarse patch stays fully applicable at or below coarseMaxLines", () => {
      const before = "one\ntwo\nthree"
      const after = "one\nchanged\nthree\nfour"
      const result = TextDiff.create("a", "a", before, after, { maxEditLength: 0, coarseMaxLines: 4 })

      expect(result.coarse).toBeTrue()
      expect(result.patch).not.toContain("elided")
      expect(applyPatch(before, result.patch)).toBe(after)
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
