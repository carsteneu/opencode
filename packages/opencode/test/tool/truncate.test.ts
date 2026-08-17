import { describe, expect, test } from "bun:test"
import { buildPreview } from "../../src/tool/truncate"

// Reference: the previous full text.split("\n")-based head/tail selection.
function referenceBuildPreview(
  text: string,
  maxLines: number,
  maxBytes: number,
  direction: "head" | "tail",
): { lines: string[]; bytes: number; hitBytes: boolean } {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  let hitBytes = false

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(lines[i])
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(lines[i])
      bytes += size
    }
  }

  return { lines: out, bytes, hitBytes }
}

function makeSeeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// Build a text with `count` lines, each `wordLen` chars + a trailing newline.
function makeText(count: number, wordLen: number, rand: () => number): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    let w = ""
    for (let j = 0; j < wordLen; j++) w += String.fromCharCode(97 + Math.floor(rand() * 26))
    parts.push(w)
  }
  return parts.join("\n") + "\n"
}

describe("truncate.buildPreview (linear, no full split)", () => {
  test("small text fits head and matches reference", () => {
    const text = "a\nb\nc\n"
    expect(buildPreview(text, 2000, 50 * 1024, "head")).toEqual(referenceBuildPreview(text, 2000, 50 * 1024, "head"))
  })

  test("head truncation by lines matches reference", () => {
    const text = "l0\nl1\nl2\nl3\nl4\n"
    for (const maxLines of [1, 3, 5, 10]) {
      for (const maxBytes of [10, 100, 10_000]) {
        expect(buildPreview(text, maxLines, maxBytes, "head")).toEqual(
          referenceBuildPreview(text, maxLines, maxBytes, "head"),
        )
      }
    }
  })

  test("head truncation by bytes matches reference", () => {
    const rand = makeSeeded(1)
    const text = makeText(200, 8, rand)
    for (const maxBytes of [16, 64, 200, 1000]) {
      for (const maxLines of [5, 50, 1000]) {
        expect(buildPreview(text, maxLines, maxBytes, "head")).toEqual(
          referenceBuildPreview(text, maxLines, maxBytes, "head"),
        )
      }
    }
  })

  test("tail truncation by lines matches reference", () => {
    const text = "l0\nl1\nl2\nl3\nl4\n"
    for (const maxLines of [1, 3, 5, 10]) {
      for (const maxBytes of [10, 100, 10_000]) {
        expect(buildPreview(text, maxLines, maxBytes, "tail")).toEqual(
          referenceBuildPreview(text, maxLines, maxBytes, "tail"),
        )
      }
    }
  })

  test("tail truncation by bytes matches reference", () => {
    const rand = makeSeeded(2)
    const text = makeText(200, 8, rand)
    for (const maxBytes of [16, 64, 200, 1000]) {
      for (const maxLines of [5, 50, 1000]) {
        expect(buildPreview(text, maxLines, maxBytes, "tail")).toEqual(
          referenceBuildPreview(text, maxLines, maxBytes, "tail"),
        )
      }
    }
  })

  test("case where text ends without trailing newline", () => {
    const text = "alpha\nbeta"
    for (const dir of ["head", "tail"] as const) {
      for (const maxLines of [1, 2, 5]) {
        expect(buildPreview(text, maxLines, 10_000, dir)).toEqual(referenceBuildPreview(text, maxLines, 10_000, dir))
      }
    }
  })

  test("empty and single-line text match reference", () => {
    for (const text of ["", "solo", "solo\n"]) {
      for (const dir of ["head", "tail"] as const) {
        for (const maxLines of [1, 2]) {
          expect(buildPreview(text, maxLines, 1000, dir)).toEqual(referenceBuildPreview(text, maxLines, 1000, dir))
        }
      }
    }
  })

  test("large short-line input stays linear (bounded work, not wall-time)", () => {
    // 4 MiB of 2-char lines = ~2M lines.
    const lineCount = 2_000_000
    const rand = makeSeeded(9)
    const text = makeText(lineCount, 2, rand)

    const start = performance.now()
    const out = buildPreview(text, 2000, 50 * 1024, "head")
    const elapsed = performance.now() - start

    expect(out.lines.length).toBeLessThanOrEqual(2000)
    // The old full-split path cost ~129 ms for this input; allow generous headroom
    // while still catching a re-introduced full split of millions of lines.
    expect(elapsed).toBeLessThan(100)
  })
})
