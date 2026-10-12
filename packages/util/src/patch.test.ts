import { describe, expect, test } from "bun:test"
import { Patch } from "@opencode/util/patch"

type Replacement = readonly [start: number, remove: number, insert: ReadonlyArray<string>]

// The behavior `applyReplacements` replaced: copy a list of lines, then splice
// each replacement in descending start order so earlier indices stay valid.
const spliceReference = (lines: ReadonlyArray<string>, replacements: ReadonlyArray<Replacement>) => {
  const next = [...lines]
  for (const [start, remove, insert] of [...replacements].reverse()) next.splice(start, remove, ...insert)
  return next
}

describe("Patch.applyReplacements", () => {
  test("matches the descending-splice behavior for ascending replacements", () => {
    const cases: ReadonlyArray<{ lines: string[]; replacements: Replacement[] }> = [
      {
        lines: ["a", "b", "c", "d"],
        replacements: [
          [1, 1, ["B"]],
          [3, 1, ["D", "D2"]],
        ],
      },
      // Equal offsets must keep insertion order.
      {
        lines: ["x"],
        replacements: [
          [1, 0, ["first"]],
          [1, 0, ["second", "third"]],
        ],
      },
      // Insert at end, empty insert, pure removal, and remove-everything.
      {
        lines: ["a", "b"],
        replacements: [
          [0, 1, []],
          [1, 1, ["mid"]],
          [2, 0, ["tail"]],
        ],
      },
      { lines: ["only"], replacements: [[0, 1, []]] },
      { lines: [], replacements: [[0, 0, ["fresh"]]] },
      { lines: ["a", "b", "c"], replacements: [[0, 3, ["collapsed"]]] },
    ]
    for (const { lines, replacements } of cases) {
      expect(Patch.applyReplacements([...lines], replacements)).toEqual(spliceReference(lines, replacements))
      expect(Patch.applyReplacements([...lines], replacements)).toEqual(spliceReference(lines, replacements))
    }
  })

  test("applies many hunks in one pass", () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
    const replacements = Array.from({ length: 5_000 }, (_, index): Replacement => {
      const start = index * 4
      return [start, 1, [`replaced ${start}`, `extra ${start}`]]
    })
    const result = Patch.applyReplacements([...lines], replacements)
    expect(result).toEqual(spliceReference(lines, replacements))
    expect(result[0]).toBe("replaced 0")
    expect(result.length).toBe(lines.length + replacements.length)
  })
})

describe("Patch.derive with many chunks", () => {
  test("rewrites a large file after one-pass replacement", () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `keep ${index}`)
    const chunks = Array.from({ length: 2_000 }, (_, index) => ({
      oldLines: [`keep ${index * 5}`],
      newLines: [`changed ${index * 5}`],
    }))
    const derived = Patch.derive("big.txt", chunks, lines.join("\n") + "\n")
    const expected = [...lines]
    for (let index = 0; index < 2_000; index++) expected[index * 5] = `changed ${index * 5}`
    expect(derived.content).toBe(expected.join("\n") + "\n")
  })
})
