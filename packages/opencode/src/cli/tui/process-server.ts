import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { writeHeapSnapshot } from "node:v8"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

type Network = { port: number; hostname: string; mdns?: boolean; cors?: string[] }
type Action =
  | { name: "snapshot" }
  | { name: "checkUpgrade"; input: { directory: string } }
  | { name: "reload" }
  | { name: "shutdown" }

type ParentMessage = Action & { id: number }
type ChildMessage =
  | { type: "ready"; url: string }
  | { type: "response"; id: number; result?: unknown; error?: string }

export async function runTuiServerChild(input: Network) {
  process.env.OPENCODE_PID = String(process.pid)
  const server = await Server.listen(input)
  const done = Promise.withResolvers<void>()
  let stopping = false

  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await InstanceRuntime.disposeAllInstances()
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
  await AppRuntime.dispose()

  async function handle(action: Action) {
    if (action.name === "snapshot") return writeHeapSnapshot("server.heapsnapshot")
    if (action.name === "checkUpgrade") {
      await InstanceRuntime.load({ directory: action.input.directory })
      await upgrade().catch(() => {})
      return
    }
    if (action.name === "reload") {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const config = yield* Config.Service
          yield* config.invalidate()
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
        }),
      )
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
  let nextID = 0
  let stopped = false
  const developmentEntry = input.entrypoint ?? (process.argv[1]?.match(/\.[cm]?[jt]s$/) ? process.argv[1] : undefined)
  const password = input.private ? (process.env.OPENCODE_SERVER_PASSWORD ?? Bun.randomUUIDv7()) : undefined
  const child = Bun.spawn([process.execPath, ...(developmentEntry ? [developmentEntry] : []), "__opencode_tui_server__"], {
    cwd: input.directory,
    detached: process.platform !== "win32",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_JSC_forceRAMSize")),
      OPENCODE_TUI_SERVER_CHILD: JSON.stringify(input.network),
      ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      if (!message || typeof message !== "object" || !("type" in message)) return
      const value = message as ChildMessage
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
  })

  void child.exited.then((code) => {
    const error = new Error(`TUI server process exited with code ${code}`)
    ready.reject(error)
    for (const response of pending.values()) response.reject(error)
    pending.clear()
  })

  const url = await Promise.race([
    ready.promise,
    Bun.sleep(20_000).then(() => Promise.reject(new Error("Timed out waiting for TUI server process"))),
  ]).catch((error) => {
    child.kill()
    throw error
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
  }

  return {
    url,
    password,
    call,
    stop,
    [Symbol.asyncDispose]: stop,
  }
}
