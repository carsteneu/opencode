// Own-process RAM/CPU probe for the streamed markdown projection.
//
// `bench/parse.ts` reports in-process CPU over several repeats; this one reports what the process
// costs from the outside (PSS, RSS, process CPU) idle and under a streaming load, so the markdown
// path has a memory number next to its CPU number. The file is copied unchanged into both
// measurement arms, see bench/prose-tail-ab.sh.
//
// Run: bun bench/prose-tail-ram.ts [targetChars] [deltaSize]

import { readFileSync } from "node:fs"
import { project, type Projection } from "../packages/session-ui/src/components/markdown-stream"
import { makeStream } from "./stream"

const targetChars = Number(process.argv[2] ?? 40_000)
const deltaSize = Number(process.argv[3] ?? 24)

const bench = makeStream(targetChars, deltaSize)

function cpuMs() {
  const usage = process.cpuUsage()

  return (usage.user + usage.system) / 1000
}

// procfs files report size 0, and Bun.file() reads them as empty - read them through node:fs
function readProc(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function pssKb() {
  const match = readProc("/proc/self/smaps_rollup").match(/^Pss:\s+(\d+) kB$/m)

  return match ? Number(match[1]) : 0
}

function rssKb() {
  const match = readProc("/proc/self/status").match(/^VmRSS:\s+(\d+) kB$/m)

  return match ? Number(match[1]) : 0
}

function sample() {
  return { pssKb: pssKb(), rssKb: rssKb() }
}

function hostLoadavg() {
  return readProc("/proc/loadavg").trim()
}

// warm the projection path so the idle sample is not measuring module initialization
for (let index = 0; index < 6; index++) {
  let projection: Projection | undefined
  let text = ""

  for (const delta of makeStream(index * 500 + 4000, deltaSize).deltas) {
    text += delta
    projection = project(projection, text, true)
  }
}

await new Promise((resolve) => setTimeout(resolve, 250))

const idle = { ...sample(), cpuMs: cpuMs() }
await new Promise((resolve) => setTimeout(resolve, 400))
const idleDeltaCpuMs = cpuMs() - idle.cpuMs

let projection: Projection | undefined
let text = ""
let peak = sample()
const cpuStart = cpuMs()
const wallStart = performance.now()

for (const [index, delta] of bench.deltas.entries()) {
  text += delta
  projection = project(projection, text, true)

  if (index % 200 === 0) {
    const current = sample()

    if (current.pssKb > peak.pssKb) peak = current
  }
}

const cpuMsTotal = cpuMs() - cpuStart
const wallMs = performance.now() - wallStart
const end = sample()
const final = sample()

if (final.pssKb > peak.pssKb) peak = final

console.log(
  JSON.stringify(
    {
      workload: {
        targetChars,
        actualChars: bench.finalLength,
        deltaSize,
        deltaCount: bench.deltaCount,
        hostLoadavg: hostLoadavg(),
      },
      idle: { pssKb: idle.pssKb, rssKb: idle.rssKb, idleWindowMs: 400, idleCpuMs: idleDeltaCpuMs },
      load: {
        pssKbPeak: peak.pssKb,
        pssKbEnd: end.pssKb,
        rssKbPeak: peak.rssKb,
        rssKbEnd: end.rssKb,
        cpuMsPerStream: cpuMsTotal,
        wallMs,
      },
      blocks: projection?.blocks.length ?? 0,
    },
    null,
    2,
  ),
)
