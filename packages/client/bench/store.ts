// Client store cost during a streamed text part.
//
// Baseline v2 (4617210822) writes the store once per delta
// (`client/src/solid/data.ts`: `text.text += event.data.delta`).
// This branch (B3) accumulates deltas per part field and flushes once per
// connection batch (`queueMicrotask` + `batch()`).
//
// Run (from the repo root): bun packages/client/bench/store.ts [targetChars] [deltaSize] [runs] [batchSize]

import { batch, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { makeStream } from "../../../bench/stream"

const targetChars = Number(process.argv[2] ?? 40_000)
const deltaSize = Number(process.argv[3] ?? 24)
const runs = Number(process.argv[4] ?? 7)
const batchSize = Number(process.argv[5] ?? 20)

const bench = makeStream(targetChars, deltaSize)

type Part = { type: "text"; text: string }
type Message = { type: "assistant"; content: Part[] }
type State = { messages: Message[] }

function cpuNow() {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

function makeState() {
  return createRoot(() => createStore<State>({ messages: [{ type: "assistant", content: [{ type: "text", text: "" }] }] }))
}

/** baseline: one store write (full string concatenation) per delta */
function runPerDelta() {
  const [state, setState] = makeState()
  const cpu0 = cpuNow()
  let wall0 = performance.now()
  for (const delta of bench.deltas) {
    setState(produce((s) => void (s.messages[0]!.content[0]!.text += delta)))
  }
  const cpuMs = cpuNow() - cpu0
  if (state.messages[0]!.content[0]!.text.length !== bench.finalLength) throw new Error("lost text")
  return { cpuMs, wallMs: performance.now() - wall0 }
}

/** B3: accumulate into a pending buffer, one write per batch inside batch() */
function runCoalesced() {
  const [state, setState] = makeState()
  const pending: string[] = []
  const cpu0 = cpuNow()
  let wall0 = performance.now()
  for (const delta of bench.deltas) {
    pending.push(delta)
    if (pending.length >= batchSize) {
      const joined = pending.join("")
      pending.length = 0
      batch(() => setState(produce((s) => void (s.messages[0]!.content[0]!.text += joined))))
    }
  }
  if (pending.length) {
    const joined = pending.join("")
    batch(() => setState(produce((s) => void (s.messages[0]!.content[0]!.text += joined))))
  }
  const cpuMs = cpuNow() - cpu0
  if (state.messages[0]!.content[0]!.text.length !== bench.finalLength) throw new Error("lost text")
  return { cpuMs, wallMs: performance.now() - wall0 }
}

/** control: pure string concatenation, no store */
function runConcatOnly() {
  const cpu0 = cpuNow()
  let text = ""
  for (const delta of bench.deltas) text += delta
  return { cpuMs: cpuNow() - cpu0, wallMs: 0, length: text.length }
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

const perDelta: number[] = []
const coalesced: number[] = []
const concatOnly: number[] = []
for (let i = 0; i < runs; i++) {
  perDelta.push(runPerDelta().cpuMs)
  coalesced.push(runCoalesced().cpuMs)
  concatOnly.push(runConcatOnly().cpuMs)
}

console.log(
  JSON.stringify(
    {
      workload: { targetChars: bench.finalLength, deltaCount: bench.deltaCount, deltaSize, runs, batchSize },
      per_delta_write_baseline: { cpuMs: summarize(perDelta) },
      coalesced_write_b3: { cpuMs: summarize(coalesced) },
      concat_only_control: { cpuMs: summarize(concatOnly) },
    },
    null,
    2,
  ),
)
