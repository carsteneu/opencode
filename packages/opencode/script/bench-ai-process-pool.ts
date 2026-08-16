import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLMAIProcess, type AIProcessInput } from "../src/session/llm/ai-process-client"

const turns = Number(process.argv[2] ?? 20)
if (!Number.isSafeInteger(turns) || turns < 2) throw new Error("Turn count must be an integer greater than one")

const root = await mkdtemp(path.join(tmpdir(), "opencode-ai-process-pool-"))
const worker = new URL("../test/fixture/ai-process-pool-worker.ts", import.meta.url).pathname

try {
  const oneShot = await measure(path.join(root, "one-shot"), 0)
  const pooled = await measure(path.join(root, "pooled"), 1)
  process.stdout.write(
    JSON.stringify(
      {
        turns,
        oneShot,
        pooled,
        warmMedianSpeedup: oneShot.warmMedianMs / pooled.warmMedianMs,
        spawnReduction: oneShot.processes - pooled.processes,
        providerInitializationReduction: oneShot.providerInitializations - pooled.providerInitializations,
      },
      undefined,
      2,
    ) + "\n",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

async function measure(state: string, max: number) {
  await Bun.write(path.join(state, ".keep"), "")
  const pids = new Set<number>()
  const pool = LLMAIProcess.createPool({
    command: [process.execPath, worker, state],
    max,
    maxUses: turns + 1,
    idleMs: 60_000,
    killGraceMs: 100,
    onSpawn(info) {
      pids.add(info.pid)
    },
  })
  const latencies: number[] = []
  try {
    for (let index = 0; index < turns; index++) {
      const input = request(index)
      const started = performance.now()
      await Effect.runPromise(
        LLMAIProcess.stream(input, {}, input.messages, new AbortController().signal, { pool }).pipe(Stream.runDrain),
      )
      latencies.push(performance.now() - started)
    }
  } finally {
    await pool.close()
  }
  return {
    processes: pids.size,
    providerInitializations: (await Array.fromAsync(new Bun.Glob("provider-*").scan({ cwd: state }))).length,
    coldMs: rounded(latencies[0]),
    medianMs: rounded(percentile(latencies, 0.5)),
    warmMedianMs: rounded(percentile(latencies.slice(1), 0.5)),
    p95Ms: rounded(percentile(latencies, 0.95)),
    stats: pool.stats(),
  }
}

function request(index: number) {
  return {
    provider: "pool-benchmark",
    package: "@ai-sdk/openai-compatible",
    model: "pool-benchmark",
    options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "benchmark" },
    modelInfo: {
      id: "pool-benchmark",
      providerID: "pool-benchmark",
      api: { id: "pool-benchmark", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
    },
    messageTransformOptions: {},
    messages: [{ role: "user", content: JSON.stringify({ label: String(index) }) }],
    tools: {},
    activeTools: [],
    headers: { "x-benchmark": "stable" },
    maxRetries: 0,
  } as unknown as AIProcessInput
}

function percentile(values: number[], fraction: number) {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function rounded(value: number) {
  return Math.round(value * 100) / 100
}
