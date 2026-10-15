import { Marked } from "marked"

export const DEFAULT_FENCE_LANGUAGE = "bash"

/**
 * A top-level fenced code block whose opener carries no language and is followed by a line terminator.
 * The terminator matters: the pinned renderer and this module lex with different markdown versions, and
 * a fence line that is the last line of the text is one shape they read differently. Indented code blocks
 * and tilde fences never match.
 */
const UNTAGGED_BACKTICK_OPENER = /^ {0,3}`{3,}[ \t]*(\r?\n)/

/** Above this the extra parse costs more than the colours are worth, and adversarial input can not force it. */
const MAX_LENGTH = 64 * 1024

const markdown = new Marked()

/**
 * Display-only rewrite: a top-level backtick fence without an info string names the default language so
 * the pinned renderer highlights the block instead of falling back to one flat colour. Only the string
 * handed to a renderable changes; the stored message and everything copied from it stay untouched.
 *
 * Lexed rather than scanned line by line: whether a fence line opens a block depends on the container
 * around it, and a line does not tell us that. A fence a list or blockquote could claim keeps its line as
 * written — for those the renderer decides, and this rewrite stays out of the way.
 */
export function withDefaultFenceLanguage(text: string, language = DEFAULT_FENCE_LANGUAGE) {
  if (text.length > MAX_LENGTH || !text.includes("```")) return text

  const openers: { start: number; end: number }[] = []
  let offset = 0
  let container = false
  for (const token of tokens(text)) {
    // A blank line ends a list or blockquote, so a fence after one is unambiguously a fresh block.
    if (token.type === "space") container = false
    if (token.type === "list" || token.type === "blockquote") container = true
    // markdown rewrites line endings in the token raws, so their offsets only count when they still show
    // the input verbatim. Anything else is left alone rather than guessed at.
    const opener =
      token.type === "code" && token.lang === "" && !container ? token.raw.match(UNTAGGED_BACKTICK_OPENER) : null
    if (opener && text.startsWith(token.raw, offset)) {
      const line = opener[0].slice(0, -opener[1]!.length)
      openers.push({ start: offset, end: offset + line.length })
    }
    offset += token.raw.length
  }
  if (openers.length === 0) return text

  let result = ""
  let cursor = 0
  for (const { start, end } of openers) {
    result += text.slice(cursor, start) + text.slice(start, end).trimEnd() + language
    cursor = end
  }
  return result + text.slice(cursor)
}

function tokens(text: string) {
  try {
    return markdown.lexer(text, { gfm: true })
  } catch {
    // Deeply nested containers overflow the lexer's stack; the transcript still has to render.
    return []
  }
}
