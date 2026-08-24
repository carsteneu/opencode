import { Server } from "@/server/server"
import { upgrade } from "@/cli/upgrade"
import { writeHeapSnapshot } from "node:v8"
import { GlobalBus } from "@/bus/global"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { ServerAuth } from "@/server/auth"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { TuiPayload } from "@/server/shared/tui-payload"
import { createWriteStream, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Server diagnostics — including bun's own internal stderr prints (e.g. EPIPE
// surfaced from torn-down stdio channels, oven-sh/bun#35064) — must never leak
// into the user's terminal. The child's stderr is pumped into this sidecar log
// instead of inheriting the TUI's tty.
function serverStderrSink() {
  const dir = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode",
    "log",
  )
  // The log directory may not exist yet on first boot — the child needs its
  // stderr sink before the main process has created anything.
  mkdirSync(dir, { recursive: true })
  return createWriteStream(join(dir, "tui-server.log"), { flags: "a" })
}

type Network = { port: number; hostname: string; mdns?: boolean; cors?: string[] }
type ChildInput = Network & { ipcEvents?: boolean }
type Action =
  | { name: "snapshot" }
  | { name: "checkUpgrade"; input: { autoupdate?: ConfigV1.Info["autoupdate"] } }
  | { name: "reload" }
  | { name: "shutdown" }

type ParentMessage = Action & { id: number }
type ChildMessage =
  | { type: "ready"; url: string }
  | { type: "response"; id: number; result?: unknown; error?: string }
  | { type: "event"; event: unknown }

export async function runTuiServerChild(input: ChildInput) {
  process.env.OPENCODE_PID = String(process.pid)
  const server = await Server.listen(input)
  const done = Promise.withResolvers<void>()
  let stopping = false
  const forwardEvent = (event: unknown) => {
    if (!isGlobalEvent(event)) return
    const projected = TuiPayload.event(event)
    if (!projected) return
    process.send?.({ type: "event", event: projected } satisfies ChildMessage)
  }
  if (input.ipcEvents) GlobalBus.on("event", forwardEvent)

  const shutdown = async () => {
    if (stopping) return
    stopping = true
    GlobalBus.off("event", forwardEvent)
    await server.stop(true)
  }

  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("id" in message) || !("name" in message)) return
    const request = message as ParentMessage
    void (async () => {
      const result = await handle(request)
      process.send?.({ type: "response", id: request.id, result } satisfies ChildMessage)
      if (request.name === "shutdown") done.resolve()
    })().catch((error) => {
      process.send?.({
        type: "response",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ChildMessage)
    })
  })
  const stop = () => void shutdown().finally(() => done.resolve())
  process.on("disconnect", stop)
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)

  process.send?.({ type: "ready", url: server.url.toString() } satisfies ChildMessage)
  await done.promise

  async function handle(action: Action) {
    if (action.name === "snapshot") return writeHeapSnapshot("server.heapsnapshot")
    if (action.name === "checkUpgrade") {
      await upgrade(action.input).catch(() => {})
      return
    }
    if (action.name === "reload") {
      await fetch(new URL("/global/dispose", server.url), {
        method: "POST",
        headers: ServerAuth.headers(),
      }).catch(() => {})
      return
    }
    await shutdown()
  }
}

export async function startTuiServerProcess(input: {
  directory: string
  network: Network
  private: boolean
  entrypoint?: string
}) {
  const ready = Promise.withResolvers<string>()
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  const eventHandlers = new Set<(event: GlobalEvent) => void>()
  let nextID = 0
  let stopped = false
  const developmentEntry = input.entrypoint ?? (process.argv[1]?.match(/\.[cm]?[jt]s$/) ? process.argv[1] : undefined)
  const password = input.private ? (process.env.OPENCODE_SERVER_PASSWORD ?? Bun.randomUUIDv7()) : undefined
  const child = Bun.spawn(
    [process.execPath, ...(developmentEntry ? [developmentEntry] : []), "__opencode_tui_server__"],
    {
      cwd: input.directory,
      detached: process.platform !== "win32",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_JSC_forceRAMSize")),
        OPENCODE_TUI_SERVER_CHILD: JSON.stringify({ ...input.network, ipcEvents: input.private }),
        ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        if (!message || typeof message !== "object" || !("type" in message)) return
        const value = message as ChildMessage
        if (value.type === "event") {
          const event = value.event
          if (!isGlobalEvent(event)) return
          eventHandlers.forEach((handler) => handler(event))
          return
        }
        if (value.type === "ready") {
          ready.resolve(value.url)
          return
        }
        const response = pending.get(value.id)
        if (!response) return
        pending.delete(value.id)
        if (value.error) {
          response.reject(new Error(value.error))
          return
        }
        response.resolve(value.result)
      },
    },
  )

  // Pump the child's stderr into a sidecar log so internal runtime prints
  // never surface in the user's terminal.
  if (child.stderr) {
    const log = serverStderrSink()
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          log.write(decoder.decode(value, { stream: true }))
        }
      } catch {
        // stream ends when the child exits or the pipe breaks
      } finally {
        reader.releaseLock()
        log.end()
      }
    })()
  }

  void child.exited.then((code) => {
    const error = new Error(`TUI server process exited with code ${code}`)
    ready.reject(error)
    for (const response of pending.values()) response.reject(error)
    pending.clear()
    eventHandlers.clear()
  })

  // Resolve as soon as the server prints its URL, but never block here: the
  // TUI must start drawing while the server finishes booting in the
  // background. Rejects on a child crash before readiness or when the
  // time-to-ready budget (20s, mirrors the previous blocking timeout) is hit.
  const url = new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (step: () => void) => {
      if (settled) return
      settled = true
      step()
    }
    ready.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
    Bun.sleep(20_000).then(() =>
      finish(() => {
        child.kill()
        reject(new Error("Timed out waiting for TUI server process"))
      }),
    )
  })

  const call = (action: Action) => {
    const response = Promise.withResolvers<unknown>()
    const id = ++nextID
    pending.set(id, response)
    child.send({ ...action, id } satisfies ParentMessage)
    return response.promise
  }

  const stop = async () => {
    if (stopped) return
    stopped = true
    const shutdown = call({ name: "shutdown" }).catch(() => undefined)
    await Promise.race([shutdown, Bun.sleep(2_000)])
    if (child.exitCode === null) {
      if (process.platform === "win32") child.kill()
      else process.kill(-child.pid, "SIGTERM")
    }
    await child.exited
    await shutdown
    eventHandlers.clear()
  }

  return {
    url,
    password,
    events: input.private
      ? {
          subscribe(handler: (event: GlobalEvent) => void) {
            eventHandlers.add(handler)
            return Promise.resolve(() => {
              eventHandlers.delete(handler)
            })
          },
        }
      : undefined,
    call,
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

function isGlobalEvent(event: unknown): event is GlobalEvent {
  if (!event || typeof event !== "object") return false
  if (!("directory" in event) || typeof event.directory !== "string") return false
  if (!("payload" in event) || !event.payload || typeof event.payload !== "object") return false
  return "type" in event.payload && typeof event.payload.type === "string"
}
