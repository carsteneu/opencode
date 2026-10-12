// TUI-side markdown cost: the terminal TUI renders streamed markdown through
// opentui's MarkdownRenderable on the MAIN thread (packages/tui/routes/session/message-parts.tsx
// passes the full text as `content`). This measures what a streaming session costs there,
// for the current full-value update and for an explicit append hint (`contentUpdate.appended`),
// which is what B2 provenance would supply.
//
// Run (from the repo root): bun packages/tui/bench/markdown.ts [targetChars] [deltaSize] [runs]

import { MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { makeStream } from "../../../bench/stream"

const targetChars = Number(process.argv[2] ?? 40_000)
const deltaSize = Number(process.argv[3] ?? 24)
const runs = Number(process.argv[4] ?? 5)

const bench = makeStream(targetChars, deltaSize)

function cpuNow() {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

async function runArm(arm: "content" | "contentUpdate"): Promise<{ cpuMs: number; perDelta: number[] }> {
  const setup = await createTestRenderer({ width: 100, height: 40 })
  const renderer = setup.renderer as unknown as { ctx?: unknown }
  const ctx = (renderer.ctx ?? renderer) as never
  const syntaxStyle = SyntaxStyle.create()
  const md = new MarkdownRenderable(ctx, {
    syntaxStyle,
    content: "",
    streaming: true,
    internalBlockMode: "top-level",
    tableOptions: { style: "grid", cellPaddingX: 1 },
  })

  const perDelta: number[] = []
  let text = ""
  const cpu0 = cpuNow()
  for (const delta of bench.deltas) {
    text += delta
    const w0 = performance.now()
    if (arm === "content") md.content = text
    else md.contentUpdate = { content: text, appended: delta }
    perDelta.push(performance.now() - w0)
  }
  const cpuMs = cpuNow() - cpu0
  md.destroy()
  setup.renderer.destroy?.()
  return { cpuMs, perDelta }
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

async function main() {
  const singleArm = process.argv[5] as "content" | "contentUpdate" | undefined
  if (singleArm) {
    // one arm, one repetition, clean process - driven by the shell runner
    const r = await runArm(singleArm)
    console.log(JSON.stringify({ arm: singleArm, cpuMs: r.cpuMs, perDeltaMs: median(r.perDelta) }))
    process.exit(0)
  }
  const arms: Array<"content" | "contentUpdate"> = ["content", "contentUpdate"]
  const report: Record<string, unknown> = {
    workload: {
      targetChars: bench.finalLength,
      deltaCount: bench.deltaCount,
      deltaSize,
      runs,
      hostLoadavg: (await Bun.file("/proc/loadavg").text()).trim(),
    },
  }
  const cpuSamples: Record<string, number[]> = { content: [], contentUpdate: [] }
  const perDelta: Record<string, number[]> = { content: [], contentUpdate: [] }
  // arms alternate per repetition so the ratio is paired against host-load drift
  for (let i = 0; i < runs; i++) {
    for (const arm of arms) {
      const r = await runArm(arm)
      cpuSamples[arm]!.push(r.cpuMs)
      perDelta[arm] = r.perDelta
    }
  }
  for (const arm of arms) {
    report[arm] = {
      cpuMs: summarize(cpuSamples[arm]!),
      perDeltaMedianMs: median(perDelta[arm]!),
      perDeltaP95Ms: [...perDelta[arm]!].sort((a, b) => a - b)[Math.floor(perDelta[arm]!.length * 0.95)],
    }
  }
  report.paired = {
    contentUpdate_over_content: summarize(cpuSamples.contentUpdate!.map((v, i) => v / cpuSamples.content![i]!)),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

void main()
