// Boundary cost: what it costs the main thread to hand a growing payload to a worker
// and to take the response back, for the current full-text protocol and the
// provenance (suffix-only) protocol.
//
// Run: bun bench/worker.ts [targetChars] [deltaSize] [runs]

import { makeStream } from "./stream"

const targetChars = Number(process.argv[2] ?? 40_000)
const deltaSize = Number(process.argv[3] ?? 24)
const runs = Number(process.argv[4] ?? 7)

const bench = makeStream(targetChars, deltaSize)

type Arm = "echo-full" | "echo-suffix" | "proj-full" | "proj-suffix"

type Sample = { postMs: number; roundTripMs: number; responseBytes: number; textLength: number }

function spawn(url: URL) {
  const worker = new Worker(url, { type: "module" })
  let nextID = 0
  const waiters = new Map<number, (value: unknown) => void>()
  worker.onmessage = (event: MessageEvent) => {
    const id = (event.data as { id: number }).id
    const resolve = waiters.get(id)
    if (resolve) {
      waiters.delete(id)
      resolve(event.data)
    }
  }
  const request = (payload: Record<string, unknown>) => {
    const id = ++nextID
    return new Promise<unknown>((resolve) => {
      waiters.set(id, resolve)
      worker.postMessage({ id, ...payload })
    })
  }
  return { request, terminate: () => worker.terminate() }
}

async function runArm(arm: Arm): Promise<Sample[]> {
  const url =
    arm.startsWith("echo")
      ? new URL("./echo.worker.ts", import.meta.url)
      : arm === "proj-full"
        ? new URL("./proj.worker.ts", import.meta.url)
        : new URL("./proj-provenance.worker.ts", import.meta.url)

  const { request, terminate } = spawn(url)
  const samples: Sample[] = []
  const provenance = arm === "echo-suffix" || arm === "proj-suffix"

  // warmup
  await request(provenance ? { key: "k", suffix: "# warmup\n\nhello" } : { key: "k", text: "# warmup\n\nhello" })

  let text = ""
  for (const delta of bench.deltas) {
    text += delta
    const post0 = performance.now()
    const pending =
      arm === "echo-full" || arm === "proj-full" ? request({ key: "k", text }) : request({ key: "k", suffix: delta })
    const postMs = performance.now() - post0
    const response = await pending
    const roundTripMs = performance.now() - post0
    const responseBytes = JSON.stringify(response).length
    samples.push({ postMs, roundTripMs, responseBytes, textLength: text.length })
  }
  terminate()
  return samples
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function pct(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function summarize(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b)
  return `median ${median(values).toFixed(3)} spread [${sorted[0]!.toFixed(3)}..${sorted.at(-1)!.toFixed(3)}]`
}

const arms: Arm[] = ["echo-full", "echo-suffix", "proj-full", "proj-suffix"]
const report: Record<string, unknown> = {
  workload: {
    targetChars: bench.finalLength,
    deltaCount: bench.deltaCount,
    deltaSize,
    runs,
    hostLoadavg: (await Bun.file("/proc/loadavg").text()).trim(),
  },
  paired: {},
}
const runTotals: Record<string, { post: number; roundTrip: number }[]> = {}

for (const arm of arms) {
  const perRun: Sample[][] = []
  for (let i = 0; i < runs; i++) perRun.push(await runArm(arm))
  runTotals[arm] = perRun.map((samples) => ({
    post: sum(samples.map((s) => s.postMs)),
    roundTrip: sum(samples.map((s) => s.roundTripMs)),
  }))
  const all = perRun.flat()
  report[arm] = {
    totalPostMs: sum(all.map((s) => s.postMs)).toFixed(1),
    totalRoundTripMs: sum(all.map((s) => s.roundTripMs)).toFixed(1),
    postMedianUs: (median(all.map((s) => s.postMs)) * 1000).toFixed(1),
    postP95Us: (pct(all.map((s) => s.postMs), 0.95) * 1000).toFixed(1),
    roundTripMedianMs: median(all.map((s) => s.roundTripMs)).toFixed(3),
    roundTripP95Ms: pct(all.map((s) => s.roundTripMs), 0.95).toFixed(3),
    responseBytesMedian: median(all.map((s) => s.responseBytes)),
  }
}

console.log(
  JSON.stringify(
    {
      ...report,
      paired: {
        // same-run ratios, robust against host-load drift between runs
        echo_suffix_over_full_post: summarize(
          runTotals["echo-suffix"]!.map((v, i) => v.post / runTotals["echo-full"]![i]!.post),
        ),
        proj_suffix_over_full_roundtrip: summarize(
          runTotals["proj-suffix"]!.map((v, i) => v.roundTrip / runTotals["proj-full"]![i]!.roundTrip),
        ),
        proj_suffix_over_full_post: summarize(
          runTotals["proj-suffix"]!.map((v, i) => v.post / runTotals["proj-full"]![i]!.post),
        ),
      },
    },
    null,
    2,
  ),
)
