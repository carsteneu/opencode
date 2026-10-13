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

function sameBlock(current: Block | undefined, next: Block | undefined) {
  if (!current || !next) return false

  return (
    current.mode === next.mode &&
    current.raw === next.raw &&
    current.src === next.src &&
    current.language === next.language &&
    current.complete === next.complete
  )
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks

  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }]

  return tailBlocks(lexer.lexer(text), text)
}

/**
 * Blocks for one lex run: every token before the final non-space token is frozen, that token and
 * the whitespace after it are the still-growing tail. `text` is the source of the run, and only
 * stands in for the tail when the run holds no token at all.
 */
function tailBlocks(tokens: ReturnType<typeof lexer.lexer>, text: string): Block[] {
  const tail = tokens.findLastIndex((token) => token.type !== "space")

  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }]
  const last = tokens[tail]

  if (!last) return [{ raw: text, src: heal(text), mode: "live" }]

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

  // `refs` keeps reference definitions on the full path twice over: a definition collapses the
  // whole text into one block, and a `def` token carries a normalized raw that would shift the
  // frozen-prefix length below.
  if (!suffix || !tail || refs(text)) return { text, blocks: stream(text, live) }

  // A code tail is extended in place instead of re-lexed. Its opener line has to be closed for
  // that: while the info string is still streaming, the suffix is language metadata rather than
  // code content, and the tail has to be re-derived.
  if (tail.mode === "code" && !tail.complete && tail.raw.includes("\n") && !closesFence(tail.raw, suffix))
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

  // Everything above the last block boundary is settled, so only the region from there on has to
  // be re-lexed. Two details decide how the region is cut:
  //  - it is cut from the text and not from `tail.raw`, because the lexer normalizes a tail's
  //    trailing whitespace, so a tail raw is not always the text suffix it came from;
  //  - it starts one block further back, because a construct can grow backwards over a boundary
  //    that held in the previous text (an unterminated html comment, a math block that only closes
  //    later). The block at that seam is re-derived, and when it does not come out unchanged the
  //    boundary is not settled and the full path takes over.
  const carry = previous.blocks.slice(0, -2)
  const seam = previous.blocks.at(-2)
  const start = carry.reduce((length, block) => length + block.raw.length, 0)
  const region = text.slice(start)
  const blocks = tailBlocks(lexer.lexer(region), region)

  if (seam && !sameBlock(blocks[0], seam)) return { text, blocks: stream(text, live) }

  return { text, blocks: [...carry, ...blocks] }
}
