import path from "node:path"
import type { ModelMessage } from "ai"
import type { AIProcessInput } from "../../src/session/llm/ai-process-client"
import { LLMWorkerIPC } from "../../src/session/llm/ipc"
import { initialize } from "./ai-process-pool-provider"

const state = process.argv[2]
if (!state) throw new Error("Pool fixture state directory is required")

await Bun.write(path.join(state, `spawn-${process.pid}`), String(process.pid))
const providerInitializations = await initialize(state)
const input = LLMWorkerIPC.lineReader(Bun.stdin.stream())
const output = LLMWorkerIPC.writer(Bun.stdout.writer())
const unexpected: unknown[] = []
let eventID = 0
let previousRun: number | undefined
let resistClose = false

type Directive = {
  action?:
    | "normal"
    | "gate"
    | "hang"
    | "crash"
    | "stderr"
    | "stderr-after-ready"
    | "gate-crash"
    | "ignore-term"
    | "end-no-ready"
    | "end-eof"
    | "wrong-run"
    | "late-event"
    | "late-tool-a"
    | "late-tool-b"
  label?: string
  started?: string
  release?: string
  stderr?: string
  written?: string
}

type ClientFrame =
  | { type: "run"; run: number; input: AIProcessInput }
  | { type: "events-ack"; run: number; id: number }
  | { type: "tool-result"; run: number; id: number; result: unknown }
  | { type: "tool-error"; run: number; id: number; error: string }

function command(messages: ModelMessage[]) {
  const content = messages.at(-1)?.content
  if (typeof content !== "string") return {} satisfies Directive
  return JSON.parse(content) as Directive
}

async function read() {
  const line = await input.read()
  if (line === undefined) return
  return LLMWorkerIPC.parse(line) as ClientFrame
}

async function acknowledgement(run: number, id: number) {
  while (true) {
    const frame = await read()
    if (!frame) throw new Error(`Missing acknowledgement for run ${run}, event ${id}`)
    if (frame.type === "events-ack" && frame.run === run && frame.id === id) return
    unexpected.push(frame)
  }
}

async function event(run: number, text: string) {
  const id = eventID++
  await output.write({ type: "events", run, id, events: [{ type: "text-delta", id: `fixture-${run}`, text }] })
  await acknowledgement(run, id)
}

async function tool(run: number, id: number) {
  await output.write({
    type: "tool",
    run,
    id,
    action: "execute",
    name: "fixture",
    input: { run },
    callID: `call-${run}`,
  })
}

async function toolResult(run: number, id: number) {
  while (true) {
    const frame = await read()
    if (!frame) throw new Error(`Missing tool result for run ${run}, tool ${id}`)
    if ((frame.type === "tool-result" || frame.type === "tool-error") && frame.run === run && frame.id === id) {
      return frame
    }
    unexpected.push(frame)
  }
}

async function finish(run: number) {
  await output.write({ type: "end", run })
  await output.write({ type: "ready", run, rss: process.memoryUsage().rss })
}

async function normal(frame: Extract<ClientFrame, { type: "run" }>, directive: Directive) {
  await event(
    frame.run,
    JSON.stringify({
      pid: process.pid,
      run: frame.run,
      label: directive.label,
      providerInitializations: providerInitializations(),
      options: frame.input.options,
      providerOptions: frame.input.providerOptions,
      headers: frame.input.headers,
      tools: Object.keys(frame.input.tools),
      unexpected: unexpected.splice(0),
    }),
  )
  await finish(frame.run)
}

while (true) {
  const frame = await read()
  if (!frame) break
  if (frame.type !== "run") {
    unexpected.push(frame)
    continue
  }
  const directive = command(frame.input.messages)

  if (directive.action === "crash") process.exit(23)

  if (directive.action === "ignore-term") {
    process.on("SIGTERM", () => {})
    resistClose = true
    await normal(frame, directive)
    previousRun = frame.run
    continue
  }

  if (directive.action === "stderr") {
    await new Promise<void>((resolve, reject) =>
      process.stderr.write(directive.stderr ?? "fixture stderr", (error) => (error ? reject(error) : resolve())),
    )
    await normal(frame, directive)
    previousRun = frame.run
    continue
  }

  if (directive.action === "stderr-after-ready") {
    if (!directive.written) throw new Error("Delayed stderr marker is required")
    await event(frame.run, JSON.stringify({ pid: process.pid, run: frame.run, state: "stderr-pending" }))
    await finish(frame.run)
    void Bun.sleep(25)
      .then(
        () =>
          new Promise<void>((resolve, reject) =>
            process.stderr.write(directive.stderr ?? "fixture stderr", (error) => (error ? reject(error) : resolve())),
          ),
      )
      .then(() => Bun.write(directive.written!, "written"))
    previousRun = frame.run
    continue
  }

  if (directive.action === "end-no-ready") {
    await output.write({ type: "end", run: frame.run })
    await new Promise(() => {})
  }

  if (directive.action === "end-eof") {
    await output.write({ type: "end", run: frame.run })
    await output.end()
    process.exit(0)
  }

  if (directive.action === "hang") {
    await event(frame.run, JSON.stringify({ pid: process.pid, run: frame.run, state: "hanging" }))
    await new Promise(() => {})
  }

  if (directive.action === "gate") {
    if (!directive.started || !directive.release) throw new Error("Gate paths are required")
    await event(frame.run, JSON.stringify({ pid: process.pid, run: frame.run, state: "gated" }))
    await Bun.write(directive.started, String(process.pid))
    while (!(await Bun.file(directive.release).exists())) await Bun.sleep(5)
    await normal(frame, directive)
    previousRun = frame.run
    continue
  }

  if (directive.action === "gate-crash") {
    if (!directive.started || !directive.release) throw new Error("Gate paths are required")
    await event(frame.run, JSON.stringify({ pid: process.pid, run: frame.run, state: "gated-crash" }))
    await Bun.write(directive.started, String(process.pid))
    while (!(await Bun.file(directive.release).exists())) await Bun.sleep(5)
    process.exit(23)
  }

  if (directive.action === "wrong-run") {
    await output.write({
      type: "events",
      run: frame.run + 1,
      id: eventID++,
      events: [{ type: "text-delta", id: "stale", text: "MUST_NOT_LEAK" }],
    })
    await new Promise(() => {})
  }

  if (directive.action === "late-event") {
    await output.write({
      type: "events",
      run: previousRun ?? frame.run - 1,
      id: eventID++,
      events: [{ type: "text-delta", id: "stale", text: "MUST_NOT_LEAK" }],
    })
    await new Promise(() => {})
  }

  if (directive.action === "late-tool-a") {
    await tool(frame.run, 0)
    await finish(frame.run)
    previousRun = frame.run
    continue
  }

  if (directive.action === "late-tool-b") {
    await event(frame.run, JSON.stringify({ pid: process.pid, run: frame.run, state: "tool-b" }))
    await tool(frame.run, 0)
    const result = await toolResult(frame.run, 0)
    await event(
      frame.run,
      JSON.stringify({ pid: process.pid, run: frame.run, result, unexpected: unexpected.splice(0) }),
    )
    await finish(frame.run)
    previousRun = frame.run
    continue
  }

  await normal(frame, directive)
  previousRun = frame.run
}

if (resistClose) await new Promise(() => {})
await output.end()
