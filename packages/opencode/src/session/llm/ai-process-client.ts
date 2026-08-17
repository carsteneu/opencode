import { Cause, Effect, Queue, Stream } from "effect"
import type { ModelMessage, Tool } from "ai"
import type { Provider } from "@/provider/provider"
import { asSchema } from "ai"
import { LLMWorkerIPC } from "./ipc"
import type { AISDKEvent } from "./ai-sdk"
import { ProviderError } from "@/provider/error"

declare global {
  const OPENCODE_LLM_PROCESS: boolean
}

export type AIProcessInput = {
  readonly provider: string
  readonly package: string
  readonly model: string
  readonly options: Record<string, unknown>
  readonly modelInfo: Provider.Model
  readonly messageTransformOptions: Record<string, unknown>
  readonly messages: ModelMessage[]
  readonly tools: Record<string, AIProcessTool>
  readonly activeTools: string[]
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, unknown>
  readonly headers: Record<string, string>
  readonly maxRetries: number
}

export type AIProcessTool = {
  readonly type?: "function" | "dynamic"
  readonly description?: string
  readonly title?: string
  readonly providerOptions?: Tool["providerOptions"]
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly inputExamples?: Array<{ input: unknown }>
  readonly needsApproval?: boolean
  readonly strict?: boolean
  readonly toModelOutput: boolean
}

type ProcessEvent =
  | { readonly type: "events"; readonly run: number; readonly id: number; readonly events: unknown[] }
  | {
      readonly type: "tool"
      readonly run: number
      readonly action: "execute"
      readonly id: number
      readonly name: string
      readonly input: unknown
      readonly callID: string
    }
  | {
      readonly type: "tool"
      readonly run: number
      readonly action: "model-output"
      readonly id: number
      readonly name: string
      readonly input: unknown
      readonly output: unknown
      readonly callID: string
    }
  | { readonly type: "end"; readonly run: number }
  | { readonly type: "ready"; readonly run: number; readonly rss: number }
  | {
      readonly type: "error"
      readonly run: number
      readonly error: string
      readonly kind?: "header-timeout" | "response-stream"
      readonly timeoutMs?: number
    }

export type ProcessOptions = {
  readonly command?: string[]
  readonly killGraceMs?: number
  readonly pool?: ProcessPool | false
}

export type PoolOptions = {
  readonly command?: string[]
  readonly max?: number
  readonly idleMs?: number
  readonly maxUses?: number
  readonly maxRssBytes?: number
  readonly killGraceMs?: number
  readonly onSpawn?: (info: { readonly pid: number; readonly pooled: boolean }) => void
}

export type PoolStats = {
  readonly pooled: number
  readonly idle: number
  readonly busy: number
  readonly spawned: number
  readonly reused: number
  readonly oneShot: number
  readonly retired: number
}

const stderrLimit = 64 * 1024
const killGraceMs = 1_000
const poolMax = 2
const poolIdleMs = 30_000
const poolMaxUses = 16
const poolMaxRssBytes = 256 * 1024 * 1024
const readyTimeoutMs = 1_000

function command() {
  if (typeof OPENCODE_LLM_PROCESS !== "undefined" && OPENCODE_LLM_PROCESS)
    return [process.execPath, "__opencode_ai_worker__"]
  return [process.execPath, new URL("./ai-process-worker.ts", import.meta.url).pathname]
}

export function enabled() {
  return process.env.NODE_ENV !== "test" && process.env.OPENCODE_DISABLE_LLM_PROCESS !== "1"
}

export function providerOptions(model: Provider.Model, provider: Provider.Info) {
  if (!["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"].includes(model.api.npm)) return false
  if (model.api.npm === "@ai-sdk/openai" && model.providerID !== "openai") return false
  if (model.api.npm === "@ai-sdk/anthropic" && model.providerID !== "anthropic") return false
  if (!serializable(provider.options)) return false
  const baseURL =
    typeof provider.options.baseURL === "string" && provider.options.baseURL !== ""
      ? provider.options.baseURL
      : model.api.url || undefined
  if (baseURL?.match(/\$\{[^}]+\}/)) return false
  if (model.api.npm === "@ai-sdk/openai-compatible" && !baseURL) return false
  const options = {
    ...provider.options,
    ...(model.api.npm === "@ai-sdk/openai-compatible" ? { includeUsage: provider.options.includeUsage !== false } : {}),
    apiKey: provider.options.apiKey === undefined ? provider.key : provider.options.apiKey,
    baseURL,
    headers: { ...provider.options.headers, ...model.headers },
  }
  return serializable(options) ? options : false
}

function serializable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (
    typeof value !== "object" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  )
    return false
  if (value instanceof Uint8Array) return true
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.every((item) => item !== undefined && serializable(item, seen))
    seen.delete(value)
    return result
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const result = Object.values(value).every((item) => serializable(item, seen))
  seen.delete(value)
  return result
}

export function inputSupported(...values: unknown[]) {
  return values.every((value) => serializable(value))
}

export function prepareTools(tools: Record<string, Tool>) {
  const entries = Object.entries(tools).map(([name, item]) => {
    if (!item.execute || item.type === "provider") return
    if (typeof item.needsApproval === "function") return
    if (item.onInputStart || item.onInputDelta || item.onInputAvailable) return
    const inputSchema = asSchema(item.inputSchema)
    const outputSchema = item.outputSchema ? asSchema(item.outputSchema) : undefined
    if (inputSchema.validate || outputSchema?.validate) return
    const value: AIProcessTool = {
      type: item.type,
      description: item.description,
      title: item.title,
      providerOptions: item.providerOptions,
      inputSchema: inputSchema.jsonSchema,
      outputSchema: outputSchema?.jsonSchema,
      inputExamples: item.inputExamples,
      needsApproval: item.needsApproval,
      strict: item.strict,
      toModelOutput: item.toModelOutput !== undefined,
    }
    if (!serializable(value)) return
    return [name, value] as const
  })
  if (entries.some((entry) => entry === undefined)) return
  return Object.fromEntries(entries.filter((entry) => entry !== undefined))
}

type ProcessWorker = ReturnType<typeof spawnWorker>
type WorkerLease = {
  readonly worker: ProcessWorker
  readonly release: (healthy: boolean, rss: number) => Promise<void>
}

export function createPool(options: PoolOptions = {}) {
  const max = Math.max(0, Math.floor(options.max ?? poolMax))
  const idleMs = Math.max(0, options.idleMs ?? poolIdleMs)
  const maxUses = Math.max(1, Math.floor(options.maxUses ?? poolMaxUses))
  const maxRssBytes = Math.max(0, options.maxRssBytes ?? poolMaxRssBytes)
  const grace = Math.max(0, options.killGraceMs ?? killGraceMs)
  const workers = new Set<ProcessWorker>()
  const oneShots = new Set<ProcessWorker>()
  let closed = false
  let spawned = 0
  let reused = 0
  let oneShot = 0
  let retired = 0
  let closing: Promise<void> | undefined

  const retire = async (worker: ProcessWorker, graceful: boolean) => {
    if (!workers.has(worker)) {
      await closeWorker(worker, graceful)
      return
    }
    if (worker.state === "closing" || worker.state === "dead") {
      await closeWorker(worker, graceful)
      return
    }
    if (worker.timer) clearTimeout(worker.timer)
    worker.timer = undefined
    worker.state = "closing"
    retired++
    await closeWorker(worker, graceful)
    workers.delete(worker)
  }
  const spawn = (key: string, pooled: boolean) => {
    const worker = spawnWorker(options.command ?? command(), grace, key, pooled)
    spawned++
    if (!pooled) {
      oneShots.add(worker)
      void worker.child.exited.then(() => {
        if (!worker.termination) oneShots.delete(worker)
      })
      try {
        options.onSpawn?.({ pid: worker.child.pid, pooled })
      } catch (error) {
        void closeWorker(worker, false).then(() => oneShots.delete(worker))
        throw error
      }
      return worker
    }
    workers.add(worker)
    void worker.child.exited.then(() => {
      const closing = worker.state === "closing"
      if (worker.timer) clearTimeout(worker.timer)
      worker.timer = undefined
      worker.state = "dead"
      if (workers.delete(worker) && !closing) retired++
    })
    try {
      options.onSpawn?.({ pid: worker.child.pid, pooled })
    } catch (error) {
      void retire(worker, false)
      throw error
    }
    return worker
  }
  const acquire = (input: AIProcessInput): WorkerLease => {
    if (closed) throw new Error("LLM process pool is closed")
    const key = poolKey(input)
    const idle = [...workers].find(
      (worker) => worker.state === "idle" && worker.key === key && worker.child.exitCode === null,
    )
    if (idle) {
      if (idle.timer) clearTimeout(idle.timer)
      idle.timer = undefined
      idle.state = "leased"
      idle.uses++
      idle.child.ref()
      idle.child.stdin.ref()
      reused++
      return { worker: idle, release: (healthy, rss) => release(idle, healthy, rss) }
    }

    const fallback = () => {
      oneShot++
      const worker = spawn(key, false)
      worker.uses++
      return {
        worker,
        release: async (healthy: boolean) => {
          await closeWorker(worker, healthy)
          oneShots.delete(worker)
        },
      }
    }
    if ([...workers].some((worker) => worker.key === key)) return fallback()

    const replace = [...workers]
      .filter((worker) => worker.state === "idle")
      .toSorted((left, right) => left.lastUsed - right.lastUsed)[0]
    if (workers.size >= max && replace) {
      void retire(replace, true)
      return fallback()
    }
    if (workers.size < max) {
      const worker = spawn(key, true)
      worker.uses++
      return { worker, release: (healthy, rss) => release(worker, healthy, rss) }
    }
    return fallback()
  }
  const release = async (worker: ProcessWorker, healthy: boolean, rss: number) => {
    if (!workers.has(worker) || worker.state === "closing" || worker.state === "dead") {
      await closeWorker(worker, false)
      return
    }
    if (!healthy || closed || worker.child.exitCode !== null || worker.uses >= maxUses || rss > maxRssBytes) {
      await retire(worker, healthy)
      return
    }
    worker.state = "idle"
    worker.lastUsed = Date.now()
    worker.stdout.release()
    worker.child.stdin.unref()
    worker.child.unref()
    const timer = setTimeout(() => {
      if (worker.state !== "idle" || worker.timer !== timer) return
      worker.timer = undefined
      void retire(worker, true)
    }, idleMs)
    worker.timer = timer
    timer.unref()
  }
  const close = () => {
    if (closing) return closing
    closed = true
    closing = Promise.all([
      ...[...workers].map((worker) => retire(worker, worker.state === "idle")),
      ...[...oneShots].map((worker) => closeWorker(worker, false)),
    ]).then(() => {
      oneShots.clear()
    })
    return closing
  }
  const stats = (): PoolStats => {
    const current = [...workers]
    return {
      pooled: current.length,
      idle: current.filter((worker) => worker.state === "idle").length,
      busy: current.filter((worker) => worker.state === "leased").length,
      spawned,
      reused,
      oneShot,
      retired,
    }
  }
  return { acquire, close, stats }
}

export type ProcessPool = ReturnType<typeof createPool>

const defaultPool = createPool()

export function stream(
  input: AIProcessInput,
  tools: Record<string, Tool>,
  messages: ModelMessage[],
  abort: AbortSignal,
  options?: ProcessOptions,
) {
  return Stream.callback<AISDKEvent, Error>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const pool =
            options?.pool === false ? undefined : (options?.pool ?? (options?.command ? undefined : defaultPool))
          const lease = pool ? pool.acquire(input) : oneShot(options)
          const worker = lease.worker
          const run = ++worker.run
          worker.stderr.reset()
          const lifecycle = new AbortController()
          const toolSignal = AbortSignal.any([abort, lifecycle.signal])
          let terminal = false
          let healthy = false
          let rss = Number.POSITIVE_INFINITY
          let sawEnd = false
          let readyTimer: Timer | undefined
          let inflightTools = 0
          let releasing: Promise<void> | undefined
          const release = () => (releasing ??= lease.release(healthy, rss))
          const write = async (value: unknown) => {
            if (terminal) return false
            await worker.input.write(value)
            return true
          }
          const fail = (error: unknown) => {
            if (terminal) return
            terminal = true
            if (readyTimer) clearTimeout(readyTimer)
            lifecycle.abort()
            void release()
            Queue.failCauseUnsafe(queue, Cause.fail(error instanceof Error ? error : new Error(String(error))))
          }
          const onAbort = () => {
            fail(new DOMException("Aborted", "AbortError"))
          }
          abort.addEventListener("abort", onAbort, { once: true })
          if (abort.aborted) onAbort()
          if (!terminal) void write({ type: "run", run, input }).catch(fail)
          const executeTool = async (message: Extract<ProcessEvent, { type: "tool" }>) => {
            const tool = tools[message.name]
            const response = await (async () => {
              try {
                if (message.action === "model-output") {
                  if (!tool?.toModelOutput) throw new Error(`Tool has no model output handler: ${message.name}`)
                  return {
                    type: "tool-result",
                    run,
                    id: message.id,
                    result: await tool.toModelOutput({
                      toolCallId: message.callID,
                      input: message.input,
                      output: message.output,
                    }),
                  }
                }
                if (!tool?.execute) throw new Error(`Tool has no execute handler: ${message.name}`)
                return {
                  type: "tool-result",
                  run,
                  id: message.id,
                  result: await tool.execute(message.input, {
                    toolCallId: message.callID,
                    messages,
                    abortSignal: toolSignal,
                  }),
                }
              } catch (error) {
                return {
                  type: "tool-error",
                  run,
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                }
              }
            })()
            inflightTools--
            await write(response)
          }
          const startTool = (message: Extract<ProcessEvent, { type: "tool" }>) => {
            inflightTools++
            void executeTool(message).catch(fail)
          }
          void read(worker.stdout, async (message) => {
            if (terminal) return false
            if (!validEvent(message, run)) throw new Error("Invalid or stale LLM process event")
            if (sawEnd && message.type !== "ready")
              throw new Error("LLM process emitted an event after ending its turn")
            if (message.type === "events") {
              const remaining = await Effect.runPromise(Queue.offerAll(queue, message.events as AISDKEvent[]))
              if (remaining.length > 0) throw new DOMException("LLM event queue closed", "AbortError")
              if (terminal) return false
              if (!(await write({ type: "events-ack", run, id: message.id })))
                throw new DOMException("LLM process input closed", "AbortError")
              return true
            }
            if (message.type === "tool") {
              startTool(message)
              return true
            }
            if (message.type === "end") {
              if (sawEnd) throw new Error("LLM process emitted duplicate end frames")
              sawEnd = true
              readyTimer = setTimeout(
                () => fail(new Error("LLM process did not become ready after ending its turn")),
                readyTimeoutMs,
              )
              readyTimer.unref()
              return true
            }
            if (message.type === "ready") {
              if (!sawEnd || inflightTools > 0 || !Number.isSafeInteger(message.rss) || message.rss < 0)
                throw new Error("LLM process became ready before completing its turn")
              if (readyTimer) clearTimeout(readyTimer)
              readyTimer = undefined
              rss = message.rss
              healthy = true
              terminal = true
              lifecycle.abort()
              Queue.endUnsafe(queue)
              return false
            }
            if (message.kind === "header-timeout") throw new ProviderError.HeaderTimeoutError(message.timeoutMs!)
            if (message.kind === "response-stream") throw new ProviderError.ResponseStreamError(message.error)
            throw new Error(message.error)
          })
            .then(async () => {
              if (terminal) return
              if (!worker.pooled) await settlesWithin(worker.stderr.done, Math.max(worker.grace, 100))
              fail(
                new Error(
                  ((worker.pooled ? "" : worker.stderr.text()) + worker.terminationError).trim() ||
                    `LLM process exited with code ${worker.child.exitCode ?? "unknown"}`,
                ),
              )
            })
            .catch(fail)
          const finish = async () => {
            if (!terminal) {
              terminal = true
              if (readyTimer) clearTimeout(readyTimer)
              lifecycle.abort()
            }
            await release()
          }
          return { onAbort, release: finish }
        }),
        ({ onAbort, release }) =>
          Effect.promise(async () => {
            abort.removeEventListener("abort", onAbort)
            await release()
          }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            Queue.failCauseUnsafe(queue, Cause.fail(error instanceof Error ? error : new Error(String(error))))
          }),
        ),
      ),
    { bufferSize: 1, strategy: "suspend" },
  )
}

async function read(
  lines: ReturnType<typeof LLMWorkerIPC.lineReader>,
  emit: (message: ProcessEvent) => boolean | Promise<boolean>,
) {
  while (true) {
    const line = await lines.read()
    if (line === undefined) return
    if (line && !(await emit(LLMWorkerIPC.parse(line) as ProcessEvent))) return
  }
}

function validEvent(value: ProcessEvent, run: number): value is ProcessEvent {
  if (!value || typeof value !== "object" || !("type" in value) || !("run" in value)) return false
  if (!Number.isSafeInteger(value.run) || value.run !== run) return false
  if (value.type === "end") return true
  if (value.type === "ready") return Number.isSafeInteger(value.rss) && value.rss >= 0
  if (value.type === "error") {
    if (typeof value.error !== "string") return false
    if (value.kind === undefined) return value.timeoutMs === undefined
    if (value.kind === "response-stream") return value.timeoutMs === undefined
    return value.kind === "header-timeout" && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs! > 0
  }
  if (!Number.isSafeInteger(value.id) || value.id < 0) return false
  if (value.type === "events") return Array.isArray(value.events)
  if (value.type !== "tool") return false
  if (!["execute", "model-output"].includes(value.action)) return false
  return typeof value.name === "string" && typeof value.callID === "string"
}

function spawnWorker(command: string[], grace: number, key: string, pooled: boolean) {
  const child = pooled
    ? Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env, lazy: true })
    : Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env, lazy: true })
  return {
    child,
    stdout: LLMWorkerIPC.lineReader(child.stdout),
    stderr: child.stderr instanceof ReadableStream ? captureStderr(child.stderr) : ignoredStderr(),
    input: LLMWorkerIPC.writer(child.stdin),
    grace,
    key,
    pooled,
    state: "leased" as "idle" | "leased" | "closing" | "dead",
    uses: 0,
    run: 0,
    lastUsed: Date.now(),
    timer: undefined as Timer | undefined,
    termination: undefined as Promise<void> | undefined,
    terminationError: "",
  }
}

function oneShot(options?: ProcessOptions): WorkerLease {
  const worker = spawnWorker(options?.command ?? command(), Math.max(0, options?.killGraceMs ?? killGraceMs), "", false)
  worker.uses++
  return { worker, release: (healthy) => closeWorker(worker, healthy) }
}

function closeWorker(worker: ProcessWorker, graceful: boolean) {
  if (worker.termination) return worker.termination
  worker.child.ref()
  worker.child.stdin.ref()
  worker.state = "closing"
  worker.termination = (async () => {
    if (graceful && worker.child.exitCode === null) {
      void worker.input.end().catch(() => undefined)
      if (await settlesWithin(worker.child.exited, worker.grace)) return
    }
    try {
      if (worker.child.exitCode === null) worker.child.kill("SIGTERM")
    } catch (error) {
      worker.terminationError += `\nFailed to send SIGTERM: ${error instanceof Error ? error.message : String(error)}`
    }
    if (await settlesWithin(worker.child.exited, worker.grace)) return
    try {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL")
    } catch (error) {
      worker.terminationError += `\nFailed to send SIGKILL: ${error instanceof Error ? error.message : String(error)}`
    }
    if (await settlesWithin(worker.child.exited, worker.grace)) return
    void worker.stdout.cancel().catch(() => undefined)
    void worker.stderr.cancel().catch(() => undefined)
    try {
      worker.child.unref()
    } catch (error) {
      worker.terminationError += `\nFailed to unref LLM process: ${error instanceof Error ? error.message : String(error)}`
    }
    worker.terminationError += "\nLLM process did not exit after SIGKILL"
  })().finally(() => {
    worker.state = "dead"
  })
  return worker.termination
}

function poolKey(input: AIProcessInput) {
  const baseURL = typeof input.options.baseURL === "string" ? input.options.baseURL : ""
  const endpoint = baseURL ? (URL.canParse(baseURL) ? new URL(baseURL).href : baseURL) : `${input.package}:default`
  return `${fingerprint({ package: input.package, provider: input.provider, endpoint })}:${fingerprint({ options: input.options, headers: input.headers })}`
}

function fingerprint(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(stable(value)).digest("hex")
}

function stable(value: unknown): string {
  if (value === undefined) return "u"
  if (value === null) return "n"
  if (typeof value === "boolean") return value ? "b1" : "b0"
  if (typeof value === "number") return `d${Object.is(value, -0) ? "-0" : String(value)}`
  if (typeof value === "string") return `s${value.length}:${value}`
  if (value instanceof Uint8Array) return `y${value.byteLength}:${Buffer.from(value).toString("base64")}`
  if (Array.isArray(value))
    return `a${value.length}:${Array.from({ length: value.length }, (_, index) => stable(index in value ? value[index] : null)).join("")}`
  if (typeof value !== "object") return `x${stable(String(value))}`
  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
  return `o${entries.length}:${entries.map(([key, item]) => `${stable(key)}${stable(item)}`).join("")}`
}

function ignoredStderr() {
  return {
    done: Promise.resolve(),
    text: () => "",
    reset: () => undefined,
    cancel: () => Promise.resolve(),
  }
}

function captureStderr(stderr: ReadableStream<Uint8Array>) {
  const ring = new Uint8Array(stderrLimit)
  const reader = stderr.getReader()
  let size = 0
  let next = 0
  let readError = ""
  const done = (async () => {
    while (true) {
      const result = await reader.read()
      if (result.done) return
      const chunk = result.value
      if (chunk.length >= ring.length) {
        ring.set(chunk.subarray(chunk.length - ring.length))
        size = ring.length
        next = 0
        continue
      }
      const first = Math.min(chunk.length, ring.length - next)
      ring.set(chunk.subarray(0, first), next)
      if (first < chunk.length) ring.set(chunk.subarray(first), 0)
      next = (next + chunk.length) % ring.length
      size = Math.min(ring.length, size + chunk.length)
    }
  })().catch((error) => {
    readError = `\nFailed to read worker stderr: ${error instanceof Error ? error.message : String(error)}`
  })

  const text = () => {
    if (size < ring.length) return new TextDecoder().decode(ring.subarray(0, size)) + readError
    const value = new Uint8Array(size)
    value.set(ring.subarray(next))
    value.set(ring.subarray(0, next), ring.length - next)
    return new TextDecoder().decode(value) + readError
  }
  const reset = () => {
    size = 0
    next = 0
    readError = ""
  }
  const cancel = () => reader.cancel()
  return { done, text, reset, cancel }
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

export const LLMAIProcess = { enabled, providerOptions, inputSupported, stream, prepareTools, createPool }
