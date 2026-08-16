import { LLMWorkerIPC } from "../../src/session/llm/ipc"

const mode = process.argv[2]
const output = LLMWorkerIPC.writer(Bun.stdout.writer())

async function connect() {
  const input = LLMWorkerIPC.lineReader(Bun.stdin.stream())
  const line = await input.read()
  if (line === undefined) throw new Error("Initial frame is required")
  const initial = LLMWorkerIPC.parse(line) as {
    type?: unknown
    run?: unknown
    input?: { options?: { fixturePayload?: unknown } }
  }
  if (initial.type !== "run" || typeof initial.run !== "number" || !initial.input) {
    throw new Error("Initial run frame is required")
  }
  let messageID = 0
  const send = async (events: unknown[]) => {
    const id = messageID++
    await output.write({ type: "events", run: initial.run, id, events })
    const line = await input.read()
    if (line === undefined) throw new Error(`Missing acknowledgement for events frame ${id}`)
    const acknowledgement = LLMWorkerIPC.parse(line) as { type?: unknown; run?: unknown; id?: unknown }
    if (acknowledgement.type !== "events-ack" || acknowledgement.run !== initial.run || acknowledgement.id !== id) {
      throw new Error(`Invalid acknowledgement for events frame ${id}`)
    }
  }
  const end = async () => {
    await output.write({ type: "end", run: initial.run })
    await output.write({ type: "ready", run: initial.run, rss: process.memoryUsage().rss })
  }
  return { request: initial.input, send, end }
}

if (mode === "stderr-before-end") {
  const client = await connect()
  await new Promise<void>((resolve, reject) =>
    process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), (error) => (error ? reject(error) : resolve())),
  )
  await client.end()
  await output.end()
  process.exit(0)
}

if (mode === "stderr-error") {
  await connect()
  await new Promise<void>((resolve, reject) =>
    process.stderr.write(`PREFIX_SHOULD_BE_DROPPED\n${"p".repeat(128 * 1024)}\nTAIL_SHOULD_SURVIVE`, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
  process.exit(7)
}

if (mode === "ignore-term") {
  process.on("SIGTERM", () => {})
  const client = await connect()
  await client.send([{ type: "text-delta", id: "fixture", text: String(process.pid) }])
  await new Promise(() => {})
}

if (mode === "slow-output") {
  const progress = process.argv[3]
  const complete = process.argv[4]
  const started = process.argv[5]
  if (!progress || !complete || !started) throw new Error("Slow output fixture paths are required")
  const frames = 512
  const text = "x".repeat(64 * 1024)
  const client = await connect()
  await client.send([{ type: "text-delta", id: "ready", text: String(process.pid) }])
  await Bun.write(started, "started")
  for (let index = 0; index < frames; index++) {
    await client.send([{ type: "text-delta", id: `frame-${index}`, text }])
    await Bun.write(progress, String(index + 1))
  }
  await Bun.write(complete, "done")
  await client.end()
  await output.end()
  process.exit(0)
}

if (mode === "initial-frame") {
  const client = await connect()
  const payload = client.request.options?.fixturePayload
  if (typeof payload !== "string") throw new Error("Initial frame payload is required")
  const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex")
  await client.send([{ type: "text-delta", id: "ack", text: `${payload.length}:${digest}` }])
  await client.end()
  await output.end()
  process.exit(0)
}

throw new Error(`Unknown AI process fixture mode: ${mode}`)
