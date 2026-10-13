// Parse-cost isolation: the real v2 worker-side projection (full re-lex per delta)
// against v1's shipped same-line append fast path (the mechanism B2 provenance enables).
//
// Run: bun bench/parse.ts [targetChars] [deltaSize] [runs]

import { project, stream, type Projection } from "../packages/session-ui/src/components/markdown-stream"
import { makeStream } from "./stream"

const targetChars = Number(process.argv[2] ?? 40_000)
const deltaSize = Number(process.argv[3] ?? 24)
const runs = Number(process.argv[4] ?? 7)

const bench = makeStream(targetChars, deltaSize)

type Result = { cpuMs: number; wallMs: number; perDelta: number[]; fullLexCount: number; fastPathCount: number }

function cpuNow() {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

/** v1's same-line append fast path: keep the stable prefix, extend the live tail. */
function projectFastPath(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live || !previous || !text.startsWith(previous.text)) return project(previous, text, live)
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix) return { text, blocks: previous.blocks }
  // Only safe when the append stays on the same line: a newline can open a new block
  // (list, fence, setext heading) and would need the block lexer. Two guards are needed:
  //  - a previous text that already ends in a newline may let the next token start a block
  //    and graduate the current live tail;
  //  - the lexer synthesizes a trailing newline into a live tail's raw, so the tail raw can
  //    end in a newline even when the text does not - concatenating onto it would inject it.
  if (tail?.mode !== "live" || suffix.includes("\n") || previous.text.endsWith("\n") || tail.raw.endsWith("\n")) {
    return project(previous, text, live)
  }
  const fragment = stream(tail.raw + suffix, true)
  // re-healing the extended raw must stay a single block, otherwise the tail split
  // and the stable prefix would be wrong.
  if (fragment.length !== 1) return project(previous, text, live)
  return {
    text,
    blocks: [...previous.blocks.slice(0, -1), { ...tail, raw: tail.raw + suffix, src: fragment[0]!.src }],
  }
}

function runProjection(variant: "current" | "fastpath"): Result {
  const perDelta: number[] = []
  let fullLexCount = 0
  let fastPathCount = 0
  let previous: Projection | undefined
  const cpu0 = cpuNow()
  let wall0 = performance.now()

  for (const delta of bench.deltas) {
    const before = previous ? previous.text : ""
    const text = before + delta
    const cpuA = cpuNow()
    const wA = performance.now()
    const next = variant === "current" ? project(previous, text, true) : projectFastPath(previous, text, true)
    const wB = performance.now()
    const cpuB = cpuNow()
    perDelta.push(wB - wA)
    if (variant === "fastpath") {
      const tail = previous?.blocks.at(-1)
      const fast =
        !!tail &&
        tail.mode === "live" &&
        !delta.includes("\n") &&
        !before.endsWith("\n") &&
        !tail.raw.endsWith("\n") &&
        stream(tail.raw + delta, true).length === 1
      if (fast) fastPathCount++
      else fullLexCount++
    }
    if (next.text !== text) throw new Error("projection lost text")
    previous = next
  }

  return {
    cpuMs: cpuNow() - cpu0,
    wallMs: performance.now() - wall0,
    perDelta,
    fullLexCount,
    fastPathCount,
  }
}

/** Upper bound probe: what the block lexer alone costs on the full text. */
function runLexerProbe() {
  let previous: Projection | undefined
  const perDelta: number[] = []
  const cpu0 = cpuNow()
  for (const delta of bench.deltas) {
    const text = (previous ? previous.text : "") + delta
    const wA = performance.now()
    stream(text, true)
    perDelta.push(performance.now() - wA)
    previous = { text, blocks: [] }
  }
  return { cpuMs: cpuNow() - cpu0, perDelta }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function summarize(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b)
  return `median ${median(samples).toFixed(1)} spread [${sorted[0]!.toFixed(1)}..${sorted.at(-1)!.toFixed(1)}]`
}

// correctness: the fast path must produce the same blocks (mode, raw AND src) as the real projection
function verifyEquivalence() {
  let a: Projection | undefined
  let b: Projection | undefined
  let structure = 0
  let raw = 0
  let src = 0
  for (const delta of bench.deltas) {
    const text = (a ? a.text : "") + delta
    a = project(a, text, true)
    b = projectFastPath(b, text, true)
    const shape = (p: Projection) => p.blocks.map((x) => x.mode).join("|")
    const raws = (p: Projection) => p.blocks.map((x) => x.raw).join("\u0000")
    const srcs = (p: Projection) => p.blocks.map((x) => x.src).join("\u0000")
    if (shape(a) !== shape(b)) structure++
    if (raws(a) !== raws(b)) raw++
    if (srcs(a) !== srcs(b)) src++
  }
  return { structure, raw, src }
}

const mismatches = verifyEquivalence()

const currentSamples: number[] = []
const fastSamples: number[] = []
const lexSamples: number[] = []
let lastCurrent: Result | undefined
let lastFast: Result | undefined
let lastLex: { cpuMs: number; perDelta: number[] } | undefined

for (let i = 0; i < runs; i++) {
  lastCurrent = runProjection("current")
  currentSamples.push(lastCurrent.cpuMs)
  lastFast = runProjection("fastpath")
  fastSamples.push(lastFast.cpuMs)
  lastLex = runLexerProbe()
  lexSamples.push(lastLex.cpuMs)
}

function bucketize(perDelta: number[], deltas: number): Record<string, number> {
  const buckets: Record<string, number> = {}
  const size = bench.finalLength
  for (let i = 0; i < perDelta.length; i++) {
    const length = Math.min(size, deltas * (i + 1))
    const key = `${Math.floor((length - 1) / 10_000) * 10}-${Math.floor((length - 1) / 10_000) * 10 + 10}KB`
    buckets[key] = (buckets[key] ?? 0) + perDelta[i]!
  }
  return buckets
}

const out = {
  workload: {
    targetChars,
    actualChars: bench.finalLength,
    deltaSize,
    deltaCount: bench.deltaCount,
    runs,
    hostLoadavg: (await Bun.file("/proc/loadavg").text()).trim(),
  },
  equivalence: {
    // three independent comparisons; a stronger check than mode+raw.length
    blockStructureMismatches: mismatches.structure,
    rawMismatches: mismatches.raw,
    srcMismatches: mismatches.src,
  },
  deltaMix: {
    sameLineDeltas: lastFast!.fastPathCount,
    newlineDeltas: lastFast!.fullLexCount,
  },
  current_full_relex: {
    cpuMs: summarize(currentSamples),
    perDeltaMedianMs: median(lastCurrent!.perDelta),
  },
  fastpath_v1_same_line: {
    cpuMs: summarize(fastSamples),
    perDeltaMedianMs: median(lastFast!.perDelta),
  },
  lexer_probe_full_lex: {
    cpuMs: summarize(lexSamples),
    perDeltaMedianMs: median(lastLex!.perDelta),
  },
  paired: {
    // same-run ratios, robust against host-load drift between runs
    fastpath_over_current: summarize(fastSamples.map((v, i) => v / currentSamples[i]!)),
    current_median_saving_pct:
      100 - (median(fastSamples) / median(currentSamples)) * 100,
  },
  cpuMs_by_text_length: {
    current: bucketize(lastCurrent!.perDelta, deltaSize),
    fastpath: bucketize(lastFast!.perDelta, deltaSize),
  },
}

console.log(JSON.stringify(out, null, 2))
