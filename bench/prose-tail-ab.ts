// Interleaved A/B of the streamed markdown projection: baseline (unpatched base commit) against the
// patch, measured in two git worktrees that both hold the identical probe file.
//
// Methodology follows yesdocs/v2-cleanup-2026-10-13/run-bench.sh: the arms alternate inside one
// measurement series, the host load average is logged per series, and the finding is the paired
// ratio with median and spread - absolute numbers are load dependent and are reported as such.
// The binary level of that script (tmux + a built CLI vs npm's native build, ready-time and process
// split) is not reproducible here: this change lives in the markdown worker, its producer is a
// TypeScript bundle, and the task forbids building a binary.
//
// Run: bun bench/prose-tail-ab.ts [rounds] [baseline-worktree]

import { $ } from "bun"

const rounds = Number(process.argv[2] ?? 5)
const patchDir = `${import.meta.dir}/..`
const baseDir = process.argv[3] ?? `${patchDir}/.yesmem/tmp/base-checkout`
const resultsDir = `${import.meta.dir}/results`

const probe = `${import.meta.dir}/prose-tail-ram.ts`
const probeSha = new Bun.CryptoHasher("sha256").update(await Bun.file(probe).text()).digest("hex")

// the arm directory is operator supplied and the runner writes into it, so refuse anything that is
// not a checkout of this repository
if (!(await Bun.file(`${baseDir}/packages/session-ui/src/components/markdown-stream.ts`).exists()))
  throw new Error(`baseline is not a checkout of this repo: ${baseDir}`)

await $`mkdir -p ${resultsDir}`.quiet()
await $`cp ${probe} ${baseDir}/bench/prose-tail-ram.ts`.quiet()

const relative = (path: string) => path.replace(`${patchDir}/`, "")
const baseHead = (await $`git rev-parse --short HEAD`.cwd(baseDir).text()).trim()
const patchHead = (await $`git rev-parse --short HEAD`.cwd(patchDir).text()).trim()

if (baseHead === patchHead) throw new Error(`baseline and patch are the same commit: ${baseHead}`)

async function loadavg() {
  const raw = await Bun.file("/proc/loadavg").text()

  return raw.trim().split(" ").slice(0, 3).join(" ")
}

function medianOf(text: string) {
  const match = text.match(/median ([\d.]+)/)

  return match ? Number(match[1]) : Number.NaN
}

function spreadOf(text: string) {
  const match = text.match(/spread \[([\d.]+)\.\.([\d.]+)\]/)

  return match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN]
}

type Sample = {
  round: number
  arm: "baseline" | "patch"
  loadBefore: string
  loadAfter: string
  /** sha256 of the file under test, so the artifact can be tied to the code it measured */
  measured: string
  parseCurrentCpuMs: number
  parseCurrentSpread: number[]
  parseFastPathCpuMs: number
  parseLexerProbeCpuMs: number
  parseEquivalence: Record<string, number>
  parseDeltaMix: Record<string, number>
  ramIdlePssKb: number
  ramIdleCpuMs: number
  ramLoadPssKbPeak: number
  ramLoadPssKbEnd: number
  ramCpuMsPerStream: number
  ramWallMs: number
  ramBlocks: number
}

const samples: Sample[] = []

for (let round = 1; round <= rounds; round++) {
  for (const arm of ["baseline", "patch"] as const) {
    const dir = arm === "baseline" ? baseDir : patchDir
    const loadBefore = await loadavg()
    const measured = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(`${dir}/packages/session-ui/src/components/markdown-stream.ts`).text())
      .digest("hex")
    const parse = JSON.parse(await $`bun bench/parse.ts 40000 24 3`.cwd(dir).quiet().text())
    const ram = JSON.parse(await $`bun bench/prose-tail-ram.ts 40000 24`.cwd(dir).quiet().text())
    const loadAfter = await loadavg()

    samples.push({
      round,
      arm,
      loadBefore,
      loadAfter,
      measured,
      parseCurrentCpuMs: medianOf(parse.current_full_relex.cpuMs),
      parseCurrentSpread: spreadOf(parse.current_full_relex.cpuMs),
      parseFastPathCpuMs: medianOf(parse.fastpath_v1_same_line.cpuMs),
      parseLexerProbeCpuMs: medianOf(parse.lexer_probe_full_lex.cpuMs),
      parseEquivalence: parse.equivalence,
      parseDeltaMix: parse.deltaMix,
      ramIdlePssKb: ram.idle.pssKb,
      ramIdleCpuMs: ram.idle.idleCpuMs,
      ramLoadPssKbPeak: ram.load.pssKbPeak,
      ramLoadPssKbEnd: ram.load.pssKbEnd,
      ramCpuMsPerStream: ram.load.cpuMsPerStream,
      ramWallMs: ram.load.wallMs,
      ramBlocks: ram.blocks,
    })

    process.stdout.write(arm === "baseline" ? "b" : "p")
  }
}

process.stdout.write("\n")

// boundary arm: one run per arm, the patch does not touch the request payload or the protocol
const worker: Record<string, unknown> = {}

for (const arm of ["baseline", "patch"] as const) {
  const dir = arm === "baseline" ? baseDir : patchDir
  const loadBefore = await loadavg()
  const raw = await $`bun bench/worker.ts 40000 24 1`.cwd(dir).quiet().text()
  const loadAfter = await loadavg()

  worker[arm] = { loadBefore, loadAfter, ...JSON.parse(raw), parseEquivalence: undefined }
}

const raw = {
  methodology: {
    arms: {
      baseline: {
        dir: relative(baseDir),
        head: baseHead,
        measured: samples.find((s) => s.arm === "baseline")?.measured,
      },
      patch: { dir: ".", head: patchHead, measured: samples.find((s) => s.arm === "patch")?.measured },
    },
    probeSha,
    rounds,
    parseCommand: "bun bench/parse.ts 40000 24 3",
    ramCommand: "bun bench/prose-tail-ram.ts 40000 24",
    workerCommand: "bun bench/worker.ts 40000 24 1",
    note: "arms alternate inside one series; absolute ms are load dependent, the paired ratio is the finding",
  },
  samples,
  worker,
}

await Bun.write(`${resultsDir}/prose-tail-ab.json`, JSON.stringify(raw, null, 2))
await Bun.write(`${resultsDir}/prose-tail-ab.ndjson`, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n")

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return {
    median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  }
}

const metrics: Array<{ metric: string; pick: (sample: Sample) => number; source: string }> = [
  {
    metric: "markdown projection CPU per 40 KB stream (median of 3 in-process runs)",
    pick: (sample) => sample.parseCurrentCpuMs,
    source: "bench/parse.ts current_full_relex.cpuMs",
  },
  {
    metric: "markdown projection CPU per stream, own process",
    pick: (sample) => sample.ramCpuMsPerStream,
    source: "bench/prose-tail-ram.ts load.cpuMsPerStream",
  },
  {
    metric: "process PSS idle",
    pick: (sample) => sample.ramIdlePssKb / 1024,
    source: "bench/prose-tail-ram.ts idle.pssKb (MiB)",
  },
  {
    metric: "process PSS peak under streaming load",
    pick: (sample) => sample.ramLoadPssKbPeak / 1024,
    source: "bench/prose-tail-ram.ts load.pssKbPeak (MiB)",
  },
  {
    metric: "process PSS after the stream",
    pick: (sample) => sample.ramLoadPssKbEnd / 1024,
    source: "bench/prose-tail-ram.ts load.pssKbEnd (MiB)",
  },
  {
    metric: "wall clock per stream",
    pick: (sample) => sample.ramWallMs,
    source: "bench/prose-tail-ram.ts load.wallMs",
  },
  {
    metric: "harness arm: v1 same-line fast path (its own fallbacks call project() too)",
    pick: (sample) => sample.parseFastPathCpuMs,
    source: "bench/parse.ts fastpath_v1_same_line.cpuMs",
  },
  {
    metric: "negative control: block lexer alone over the full text (identical code in both arms)",
    pick: (sample) => sample.parseLexerProbeCpuMs,
    source: "bench/parse.ts lexer_probe_full_lex.cpuMs",
  },
]

const rows = metrics.map((metric) => {
  const baseline = samples.filter((sample) => sample.arm === "baseline").map(metric.pick)
  const patch = samples.filter((sample) => sample.arm === "patch").map(metric.pick)
  const paired = baseline.map((value, index) => value / patch[index]!)

  return {
    metric: metric.metric,
    baseline: summarize(baseline).median,
    baselineSpread: [summarize(baseline).min, summarize(baseline).max],
    patch: summarize(patch).median,
    patchSpread: [summarize(patch).min, summarize(patch).max],
    ratio: summarize(paired).median,
    ratioSpread: [summarize(paired).min, summarize(paired).max],
    n: paired.length,
    load: `${samples[0]!.loadBefore} .. ${samples.at(-1)!.loadAfter}`,
    source: metric.source,
  }
})

console.log(JSON.stringify({ rows, worker }, null, 2))
