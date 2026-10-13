import { describe, expect, test } from "bun:test"
import { project, stream, type Projection } from "./markdown-stream"

// Equivalence is the contract of the incremental tail: for every append the projection must be
// byte-identical to a full re-lex of the same text. The corpus below carries every construct the
// lexer can branch on, and every document is streamed under many different delta splits, because
// the split is what decides which block is the live tail.
const DOCUMENTS = {
  prose: [
    "The streaming path keeps a growing document on the critical path, so every delta has to be",
    "reconciled against what the reader already sees.",
    "",
    "A worker removes the parse from the render thread, yet it does not remove the boundary.",
  ].join("\n"),
  blocks: [
    "# Title",
    "",
    "Opening paragraph with **bold**, _emphasis_, `inline code` and a [link](https://example.com/a).",
    "",
    "## Section",
    "",
    "- first item",
    "- second item with `inline-2`",
    "  - nested item",
    "    - deeper item",
    "",
    "1. ordered one",
    "2. ordered two",
    "",
    "- [ ] open task",
    "- [x] done task",
    "",
    "> quoted note",
    "> second line",
    "",
    "Final paragraph.",
  ].join("\n"),
  fences: [
    "Before the fence.",
    "",
    "```ts title=example",
    "export function section(input: string): string {",
    "  const value = input.trim()",
    '  return value.length > 0 ? value : "section"',
    "}",
    "```",
    "",
    "Between the fences.",
    "",
    "~~~sh",
    "echo hello",
    "~~~",
    "",
    "After the fences.",
  ].join("\n"),
  fenceAtEnd: ["Intro line.", "", "```js", "const one = 1", "const two = 2", "```"].join("\n"),
  unclosedFence: ["Intro.", "", "```python", "def value():", "    return 42"].join("\n"),
  table: ["| column | other |", "| ------ | ----- |", "| 1      | 2     |", "| 3      | 4     |", "", "After."].join(
    "\n",
  ),
  math: [
    "Inline $x^2 + y^2$ and \\(P(x_{t+1})\\) stay text.",
    "",
    "$$",
    "a",
    "",
    "b",
    "$$",
    "",
    "After the display block.",
  ].join("\n"),
  mathDelimiters: ["Fractions like $\\frac{1}{2}$ and $\\frac{3}{4}$ in one line.", "", "Then $a$ and $b$."].join("\n"),
  references: [
    "See [docs][1] and [guide][2].",
    "",
    "[1]: https://example.com/one",
    "[2]: https://example.com/two",
  ].join("\n"),
  referenceLate: ["See [docs][1].", "", "[1]: https://example.com/one", "", "Trailing paragraph."].join("\n"),
  setext: ["Title", "=====", "", "Subtitle", "-----", "", "Body after setext headings."].join("\n"),
  rules: ["Above.", "", "---", "", "Between.", "", "***", "", "Below."].join("\n"),
  html: ['<div class="wrapper">', "", "Markdown inside?", "", "</div>", "", "After the html block."].join("\n"),
  blankLines: ["Paragraph one.", "", "", "", "Paragraph two.", "", "Tail."].join("\n"),
  trailingNewlines: ["Content here.", "", ""].join("\n"),
  indented: ["    indented code line", "    second line", "", "After indented code."].join("\n"),
  delimiters: [
    "**bold** and *italic* and _underscore_ and `code` and ~~strike~~.",
    "",
    "A [link](https://example.com) plus ![image](https://example.com/i.png) and <https://example.com>.",
    "",
    "Escapes \\*not bold\\* and entities &amp; stay put.",
  ].join("\n"),
  listContinuation: ["- item with a long paragraph", "", "  continuation indented by two", "", "Trailing."].join("\n"),
} satisfies Record<string, string>

// Reference definitions collapse the whole text into one block, so every append takes the full path.
const REFERENCES = ["references", "referenceLate"]

// A construct can grow backwards over a boundary the previous text had, and then one append has to
// re-lex everything: the display math block only becomes a block token once its closing delimiter
// arrives, and that token starts above the boundary of the text before it.
const FULL_PATH_APPENDS = { math: 1 } satisfies Record<string, number>

function seeded(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0

    return state / 0xffffffff
  }
}

/** Splits at fixed size, so a delta regularly lands inside a fence, a delimiter or a table row. */
function fixedChunks(text: string, size: number) {
  const deltas: string[] = []

  for (let index = 0; index < text.length; index += size) deltas.push(text.slice(index, index + size))

  return deltas
}

function randomChunks(text: string, seed: number, max: number) {
  const random = seeded(seed)
  const deltas: string[] = []
  let index = 0

  while (index < text.length) {
    const size = 1 + Math.floor(random() * max)

    deltas.push(text.slice(index, index + size))
    index += size
  }

  return deltas
}

/** Splits after every structural boundary, so each construct starts at its own delta. */
function boundaryChunks(text: string) {
  const deltas: string[] = []
  let start = 0

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (char === "\n" || char === "|" || char === "$" || char === "`" || char === "*" || char === "\\") {
      deltas.push(text.slice(start, index + 1))
      start = index + 1
    }
  }

  if (start < text.length) deltas.push(text.slice(start))

  return deltas
}

function splits(text: string) {
  const named: Array<[string, string[]]> = [
    ["chars", fixedChunks(text, 1)],
    ["pairs", fixedChunks(text, 2)],
    ["words", fixedChunks(text, 7)],
    ["blocks", fixedChunks(text, 32)],
    ["boundaries", boundaryChunks(text)],
    ["random-3", randomChunks(text, 1, 3)],
    ["random-11", randomChunks(text, 2026, 11)],
    ["random-40", randomChunks(text, 913, 40)],
  ]

  return named.map(([name, deltas]) => ({ name, deltas }))
}

type Step = { index: number; text: string; previous: Projection | undefined; next: Projection }

/**
 * Streams the document through project() and returns every step. A step where the first block is
 * rebuilt while the previous projection had at least three blocks took the full path.
 */
function streamDocument(name: string, text: string, deltas: string[]) {
  const steps: Step[] = []
  let previous: Projection | undefined
  let current = ""
  let fullPath = 0

  for (const [index, delta] of deltas.entries()) {
    const before = previous
    current += delta
    const next = project(before, current, true)

    expect(next.text, `lost text at step ${index}`).toBe(current)
    // the incremental path must never disagree with a full re-lex
    expect(next.blocks, `diverged from the full re-lex at step ${index}`).toEqual(stream(current, true))

    if (before && before.blocks.length > 2)
      if (next.blocks[0] === before.blocks[0]) {
        // the prefix above the seam is carried over by reference, block for block
        for (let block = 0; block < before.blocks.length - 2; block++)
          expect(next.blocks[block], `block ${block} was rebuilt at step ${index}`).toBe(before.blocks[block])
      } else fullPath++

    steps.push({ index, text: current, previous: before, next })
    previous = next
  }

  if (!REFERENCES.includes(name))
    expect(fullPath, "unexpected full-path appends").toBeLessThanOrEqual(FULL_PATH_APPENDS[name] ?? 0)

  return steps
}

describe("markdown stream incremental equivalence", () => {
  for (const [name, text] of Object.entries(DOCUMENTS)) {
    describe(name, () => {
      for (const split of splits(text)) {
        test(`matches the full re-lex under ${split.name} deltas`, () => {
          streamDocument(name, text, split.deltas)
        })
      }

      test("finalizes the incremental projection", () => {
        const steps = streamDocument(name, text, fixedChunks(text, 5))
        const last = steps.at(-1)!.next
        const final = project(last, last.text, false)

        expect(final.text).toBe(last.text)
        expect(final.blocks.map((block) => block.raw)).toEqual(last.blocks.map((block) => block.raw))

        for (let block = 0; block < last.blocks.length - 1; block++)
          expect(final.blocks[block]).toBe(last.blocks[block])

        for (const block of final.blocks) {
          expect(block.mode).not.toBe("live")

          if (block.mode === "code") expect(block.complete).toBe(true)
        }
      })
    })
  }

  test("stays incremental for every append of a document that cannot grow backwards", () => {
    const steps = streamDocument("blocks", DOCUMENTS.blocks, fixedChunks(DOCUMENTS.blocks, 3))
    const eligible = steps.filter((step) => step.previous && step.previous.blocks.length > 2)
    const carried = eligible.filter((step) => step.next.blocks[0] === step.previous!.blocks[0])

    expect(eligible.length).toBeGreaterThan(20)
    expect(carried.length).toBe(eligible.length)
  })
})
