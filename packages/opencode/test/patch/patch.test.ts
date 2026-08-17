import { describe, expect, test } from "bun:test"
import { applyReplacements, deriveNewContentsFromChunks, type UpdateFileChunk } from "../../src/patch"
import { join as bomJoin } from "../../src/util/bom"

type Replacement = [number, number, string[]]

// Reference implementation of the previous (quadratic) algorithm. Kept here so
// the linear replacement can be proven byte-identical against it.
function referenceApplyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines]

  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]

    result.splice(startIdx, oldLen)

    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j])
    }
  }

  return result
}

// Deterministic pseudo-random source so large cases are reproducible.
function makeSeeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function overlapFreeReplacements(lineCount: number, count: number, rand: () => number, ceil = lineCount): Replacement[] {
  const parts: Replacement[] = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    cursor += Math.floor(rand() * 3)
    const start = Math.min(cursor, Math.max(ceil - 1, 0))
    const oldLen = Math.min(1 + Math.floor(rand() * 2), Math.max(ceil - start, 0))
    const newLen = Math.floor(rand() * 4)
    const newSegment: string[] = []
    for (let j = 0; j < newLen; j++) newSegment.push(`new-${i}-${j}`)
    parts.push([start, oldLen, newSegment])
    cursor = start + oldLen
    if (cursor >= ceil) break
  }
  return parts
}

describe("patch.applyReplacements (linear)", () => {
  test("single insertion in the middle is byte-identical to reference", () => {
    const lines = ["a", "b", "c", "d", "e"]
    const replacements: Replacement[] = [[2, 1, ["X", "Y"]]]

    expect(applyReplacements(lines, replacements)).toEqual(referenceApplyReplacements(lines, replacements))
    expect(applyReplacements(lines, replacements)).toEqual(["a", "b", "X", "Y", "d", "e"])
  })

  test("pure deletion (empty newSegment)", () => {
    const lines = ["a", "b", "c"]
    const replacements: Replacement[] = [[1, 2, []]]

    expect(applyReplacements(lines, replacements)).toEqual(referenceApplyReplacements(lines, replacements))
    expect(applyReplacements(lines, replacements)).toEqual(["a"])
  })

  test("insertion at start and at end", () => {
    const lines = ["b", "c"]
    const replacements: Replacement[] = [
      [0, 0, ["head"]],
      [2, 0, ["tail"]],
    ]

    expect(applyReplacements(lines, replacements)).toEqual(referenceApplyReplacements(lines, replacements))
    expect(applyReplacements(lines, replacements)).toEqual(["head", "b", "c", "tail"])
  })

  test("multiple hunks in overlap-free order are byte-identical to reference", () => {
    const lines = ["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]
    const replacements: Replacement[] = [
      [1, 2, ["r1", "r2"]],
      [5, 1, ["r5"]],
      [7, 1, []],
    ]

    expect(applyReplacements(lines, replacements)).toEqual(referenceApplyReplacements(lines, replacements))
  })

  test("large middle insertion matches reference and keeps byte order", () => {
    const lineCount = 5_000
    const lines = Array.from({ length: lineCount }, (_, i) => `line-${i}`)
    const rand = makeSeeded(42)
    const midIdx = Math.floor(lineCount / 2)

    // Generate replacements strictly below midIdx so midIdx is guaranteed free.
    const replacements = overlapFreeReplacements(lineCount, 1_000, rand, midIdx)

    const big = Array.from({ length: 2_000 }, (_, i) => `big-${i}`)
    replacements.push([midIdx, 0, big])

    const linear = applyReplacements(lines, replacements)
    const reference = referenceApplyReplacements(lines, replacements)

    expect(linear).toEqual(reference)
    expect(linear.length).toBe(reference.length)
  })

  test("large replacement set stays linear (bounded work, not wall-time)", () => {
    const lineCount = 10_000
    const lines = Array.from({ length: lineCount }, (_, i) => `line-${i}`)
    const rand = makeSeeded(7)
    const replacements = overlapFreeReplacements(lineCount, 4_000, rand)

    const start = performance.now()
    const out = applyReplacements(lines, replacements)
    const elapsed = performance.now() - start

    expect(out.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})

describe("patch.deriveNewContentsFromChunks (public path)", () => {
  test("preserves BOM through replacement", () => {
    const original = "\uFEFFline1\nline2\nline3\n"
    const chunks: UpdateFileChunk[] = [{ old_lines: ["line2"], new_lines: ["line2b"] }]

    const result = deriveNewContentsFromChunks("f.ts", chunks, original)

    expect(result.bom).toBe(true)
    expect(bomJoin(result.content, true)).toBe("\uFEFFline1\nline2b\nline3\n")
    expect(result.content).toBe("line1\nline2b\nline3\n")
  })

  test("adds missing final newline", () => {
    const original = "line1\nline2"
    const chunks: UpdateFileChunk[] = [{ old_lines: ["line1"], new_lines: ["line1x"] }]

    const result = deriveNewContentsFromChunks("f.ts", chunks, original)

    expect(result.content).toBe("line1x\nline2\n")
  })

  test("multi-hunk apply over the public path", () => {
    const original = "a\nb\nc\nd\n"
    const chunks: UpdateFileChunk[] = [
      { old_lines: ["a"], new_lines: ["a1"] },
      { old_lines: ["c"], new_lines: ["c1"] },
    ]

    const result = deriveNewContentsFromChunks("f.ts", chunks, original)

    expect(result.content).toBe("a1\nb\nc1\nd\n")
  })
})
