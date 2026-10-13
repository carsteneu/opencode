// Synthetic markdown-heavy assistant stream, split into LLM-sized deltas.
// Used by the B2 (append provenance) measurement harness.

export type Stream = {
  /** the full text as streamed */
  full: string
  /** successive cumulative prefixes? no - raw deltas in arrival order */
  deltas: string[]
  finalLength: number
  deltaCount: number
}

const PROSE = [
  "The streaming path keeps a growing document on the critical path, so every delta that lands has to be reconciled against what the reader already sees.",
  "In practice the interesting question is not whether parsing happens at all, but where it happens and what it costs the thread that owns the frame.",
  "A worker removes the parse from the render thread, yet it does not remove the boundary: the payload still has to cross and come back.",
  "Provenance turns an append into an append: the receiver knows the new text is the old text plus a suffix, so it can reuse the stable prefix instead of rebuilding it.",
  "Without that hint the safe default is a full value replacement, which is correct and cold.",
  "The measured cost of that default is what this benchmark is here to expose.",
]

const LIST_ITEMS = [
  "stable prefix reuse",
  "tail reconciliation",
  "block boundary detection",
  "fence healing for unfinished code",
  "token reuse across frames",
  "retained partial rendering",
]

function codeBlock(language: string, lines: string[]): string {
  return ["```" + language, ...lines, "```"].join("\n")
}

/**
 * Builds a deterministic, markdown-heavy document of roughly `targetChars`
 * characters (clamped by the repeating structure) and slices it into deltas.
 */
export function makeStream(targetChars: number, deltaSize = 24, seed = 1): Stream {
  if (!Number.isInteger(targetChars) || targetChars <= 0) throw new Error("targetChars must be a positive integer")
  if (!Number.isInteger(deltaSize) || deltaSize <= 0) throw new Error("deltaSize must be a positive integer")
  let state = seed >>> 0
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }

  const parts: string[] = []
  let section = 0
  while (parts.join("").length < targetChars) {
    section++
    parts.push(`## Section ${section}\n\n`)
    for (let i = 0; i < 3; i++) {
      parts.push(PROSE[Math.floor(rand() * PROSE.length)] + " ")
      parts.push(PROSE[Math.floor(rand() * PROSE.length)] + "\n\n")
    }
    parts.push(`- ${LIST_ITEMS[Math.floor(rand() * LIST_ITEMS.length)]}\n`)
    parts.push(`- \`inline-${section}\` keeps the lexer honest\n\n`)
    parts.push(codeBlock("ts", [
      `export function section${section}(input: string): string {`,
      `  const value = input.trim()`,
      `  return value.length > 0 ? value : "section-${section}"`,
      `}`,
    ]) + "\n\n")
    parts.push(`> quoted note ${section}\n\n`)
  }

  const full = parts.join("").slice(0, targetChars)
  const deltas: string[] = []
  for (let i = 0; i < full.length; i += deltaSize) deltas.push(full.slice(i, i + deltaSize))

  const joined = deltas.join("")
  if (joined !== full) throw new Error("delta slicing is lossy")

  return { full, deltas, finalLength: full.length, deltaCount: deltas.length }
}
