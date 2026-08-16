import { Effect, Stream } from "effect"
import { LLMAIProcess, type AIProcessInput } from "../../src/session/llm/ai-process-client"

const state = process.argv[2]
const result = process.argv[3]
const dispose = process.argv[4] === "dispose"
if (!state || !result) throw new Error("Pool parent fixture paths are required")

const pool = LLMAIProcess.createPool({
  command: [process.execPath, new URL("./ai-process-pool-worker.ts", import.meta.url).pathname, state],
  idleMs: 60_000,
  killGraceMs: 25,
})
const input = {
  provider: "pool",
  package: "@ai-sdk/openai-compatible",
  model: "pool-model",
  options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "pool-key" },
  modelInfo: {
    id: "pool-model",
    providerID: "pool",
    api: { id: "pool-model", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
  },
  messageTransformOptions: {},
  messages: [{ role: "user", content: JSON.stringify({ label: dispose ? "dispose" : "natural" }) }],
  tools: {},
  activeTools: [],
  headers: { "x-pool-affinity": "stable" },
  maxRetries: 0,
} as unknown as AIProcessInput
const events = await Effect.runPromise(
  LLMAIProcess.stream(input, {}, input.messages, new AbortController().signal, { pool, killGraceMs: 25 }).pipe(
    Stream.runCollect,
  ),
)
const text = events.find((event) => event.type === "text-delta")
if (!text || text.type !== "text-delta") throw new Error("Pool parent fixture received no worker metadata")
await Bun.write(result, text.text)
if (dispose) await pool.close()
