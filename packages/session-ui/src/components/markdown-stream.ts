import { Marked, type Tokens } from "marked"
import remend from "remend"
import { markdownMath } from "@opencode/ui/context/marked-parser"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

// Split with the renderer's math syntax so a display block is never cut into separately rendered pieces.
const lexer = new Marked(markdownMath)

function refs(text: string) {
  if (!text.includes("]:")) return false

  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")

  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)

  if (!match) return false
  const mark = match[1]

  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""

  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]

  if (!mark) return suffix.includes("```") || suffix.includes("~~~")

  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

/**
 * Every markdown construct that ends a block is a line made only of structure characters (a fence,
 * a setext underline, a rule, a math delimiter, a table delimiter). A line that still holds a letter
 * or a digit cannot turn into one, so a line like that is safe to extend. Trailing blank lines are
 * ignored: they end constructs rather than complete them.
 */
function structuralLine(raw: string) {
  const content = raw.replace(/\n+$/, "")
  const line = content.slice(content.lastIndexOf("\n") + 1)

  return !/[\p{L}\p{N}]/u.test(line)
}

/**
 * A delta can carry several lines and any of them can end a construct that started above the tail,
 * so all of them are checked. The last line is left to `structuralLine`, which owns the case of a
 * line that is still being extended.
 */
function structuralSpan(text: string) {
  return text
    .split("\n")
    .slice(0, -1)
    .some((line) => line.trim() !== "" && structuralLine(line))
}

/**
 * marked only allows spaces before a fence, while `open()` also accepts a tab - and a tab-indented
 * line is an indented code block, whose raw has no fence to extend.
 */
function fenceLine(raw: string) {
  return /^ {0,3}(`{3,}|~{3,})/.test(raw)
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks

  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = lexer.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")

  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]

  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []

  for (let index = 0; index < tail; index++) {
    const token = tokens[index]

    if (!token || token.type === "space") continue
    let raw = token.raw

    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw

    if (token.type === "code") {
      // SAFETY: only marked's built-in fence tokenizer emits `code`; the math extensions use their own token types.
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }

    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")

  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  // SAFETY: only marked's built-in fence tokenizer emits `code`; the math extensions use their own token types.
  const code = last as Tokens.Code

  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]

  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live) {
    const current =
      previous?.text === text
        ? previous
        : previous && text.startsWith(previous.text)
          ? project(previous, text, true)
          : undefined

    if (!current) return completedProjection(text)

    return {
      text,
      blocks: current.blocks.map((block) => {
        if (block.mode === "live") return { raw: block.raw, src: block.raw, mode: "full" }

        if (block.mode === "code" && !block.complete) return { ...block, complete: true }

        return block
      }),
    }
  }

  if (!previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)

  if (!suffix || !tail) return { text, blocks: stream(text, live) }

  // The lexer replaces carriage returns before it lexes, so a raw is never a byte-exact suffix of
  // the text it came from. Appending across a CR, or onto text that is about to be normalized, has
  // to go through the full path.
  if (suffix.includes("\r") || previous.text.endsWith("\r")) return { text, blocks: stream(text, live) }

  // A code tail is extended in place instead of re-lexed. Its opener line has to be closed for
  // that: while the info string is still streaming, the suffix is language metadata rather than
  // code content, and the tail has to be re-derived. The appended lines must not end a construct
  // above the fence - neither on the line still being extended nor on any earlier line of the
  // delta - and a reference definition collapses the whole text into a single block, so an append
  // that completes one cannot be answered with a code block. That last check scans the whole text,
  // so it is only paid when this branch would otherwise fire.
  if (
    tail.mode === "code" &&
    !tail.complete &&
    fenceLine(tail.raw) &&
    tail.raw.includes("\n") &&
    !structuralLine(tail.raw + suffix) &&
    !structuralSpan(suffix) &&
    !closesFence(tail.raw, suffix) &&
    !refs(text)
  )
    return {
      text,
      blocks: [
        ...previous.blocks.slice(0, -1),
        {
          ...tail,
          raw: tail.raw + suffix,
          src: tail.src + suffix,
        },
      ],
    }

  return { text, blocks: stream(text, live) }
}
