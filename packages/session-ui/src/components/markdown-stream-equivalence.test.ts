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
  // Every document below was found by randomized or adversarial search to break an incremental
  // tail: the constructs they carry either span several blocks once their terminator arrives, or a
  // settled boundary in them is destroyed by the append that follows.
  spanningMath: ["a", "", "$$", "# b", "", "c", "$$", "", "After."].join("\n"),
  spanningMathQuote: ["$$", "", "> code in quote", "", "$$"].join("\n"),
  splitCloser: ["$$", "x", "$"].join("\n"),
  setextSwallowsRule: ["a", "***", "b", "===", "", "After."].join("\n"),
  listAbsorbsParagraph: "12) paren\n\n12)\n\nAfter.\n",
  emptyHeadingDestroyed: ["\\)", "######", "# not a heading"].join("\n"),
  crlfProse: "line one\r\n\r\nline two\r\n\r\nlive tail",
  crlfFence: "before\r\n\r\n```ts\r\nconst x = 1\r\n```\r\n\r\nafter\r\n",
  leadingBlankLine: "  \na\n\na\n\nne",
  duplicateDefinitions: "[a][1]\n\n[1]: https://one\n\n[1]: https://two\n\nlive tail",
  fenceOpenerSplit: "Intro.\n\n```ts title=example",
  structuralCloser: "$$\n\n```ts\nvalue\n$$\n",
} satisfies Record<string, string>

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
 * Streams the document through project() one delta at a time. Every append has to return exactly
 * what a full re-lex of the same text returns - that is the contract the streaming path is held to,
 * and the reason the tail falls back to the full re-lex whenever it cannot extend in place.
 */
function streamDocument(text: string, deltas: string[]) {
  const steps: Step[] = []
  let previous: Projection | undefined
  let current = ""

  for (const [index, delta] of deltas.entries()) {
    const before = previous
    current += delta
    const next = project(before, current, true)

    expect(next.text, `lost text at step ${index}`).toBe(current)
    expect(next.blocks, `diverged from the full re-lex at step ${index}`).toEqual(stream(current, true))

    steps.push({ index, text: current, previous: before, next })
    previous = next
  }

  return steps
}

describe("markdown stream equivalence", () => {
  for (const [name, text] of Object.entries(DOCUMENTS)) {
    describe(name, () => {
      for (const split of splits(text)) {
        test(`matches the full re-lex under ${split.name} deltas`, () => {
          streamDocument(text, split.deltas)
        })
      }

      test("finalizes the projection", () => {
        const steps = streamDocument(text, fixedChunks(text, 5))
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
})
