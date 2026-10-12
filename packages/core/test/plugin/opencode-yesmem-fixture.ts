// Shared harness for the opencode-yesmem plugin tests.
//
// The plugin lives outside every tsconfig project (deliberate: plugin sources are runtime files), so tests
// load it through the real host loader and describe its exports with local type declarations — the same
// pattern packages/tui/test/plugin-*.test.tsx uses.
//
// The plugin uses the Effect plugin API, so the fake context registers Effect-returning hooks and `fire`
// runs them through the Effect runtime, exactly like the core hook dispatcher does.

import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Host } from "@opencode/plugin/host"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Cause, Effect, Exit, Stream } from "effect"

// External plugins import `effect` and `@opencode/plugin` from the host; the CLI installs that mapping at
// startup (packages/cli/src/index.ts) and the core plugin tests install it the same way.
ensurePluginRuntime()

export const yesmemEntry = (file: string) =>
  new URL(`../../../../.opencode/plugin-suite/opencode-yesmem/${file}`, import.meta.url).href

export type RpcResponse = { ok: boolean; result?: any; error?: string }

export type EffectPluginModule = {
  default: { id: string; effect: (context: unknown) => Effect.Effect<unknown, never, never> }
}

export type DaemonRequest = { method: string; params: Record<string, any> }

export async function mockDaemon(handler: (request: DaemonRequest) => unknown | undefined) {
  const directory = await mkdtemp(path.join(tmpdir(), "yesmem-daemon-"))
  const socketPath = path.join(directory, "daemon.sock")
  const requests: DaemonRequest[] = []
  const sockets = new Set<Socket>()
  // allowHalfOpen: the real daemon keeps its side open in a decode loop, so a client half-close must not
  // auto-close the server side (that would fake an EOF response from a daemon that never answered).
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      while (true) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line) as DaemonRequest
        requests.push(request)
        const response = handler(request)
        if (response === undefined) continue
        socket.write(JSON.stringify(response) + "\n")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    /** Requests after the activation-time index priming that `setup` performs. */
    hooked: (from = 1) => requests.slice(from),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Runs `body` with YESMEM_SOCKET pointed at `daemon` and restores the previous value afterwards. */
export async function withSocket<T>(socketPath: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.YESMEM_SOCKET
  process.env.YESMEM_SOCKET = socketPath
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.YESMEM_SOCKET
    else process.env.YESMEM_SOCKET = previous
  }
}

export type HookEvent = Record<string, any>
export type HookCallback = (event: HookEvent) => unknown
export type HookResult = { readonly event: HookEvent; readonly error?: any }

export type HookRecorder = {
  readonly hooks: Map<string, HookCallback[]>
  readonly context: any
  /** Runs every registered callback in registration order; a failure stops the chain, as in the host. */
  fire: (key: string, event: HookEvent) => Promise<HookResult>
}

function firstFailure(cause: Cause.Cause<unknown>) {
  for (const reason of cause.reasons) if (Cause.isFailReason(reason)) return reason.error as any
  return undefined
}

/**
 * Minimal stand-in for the effect plugin context: it records hook registrations under
 * `<domain>.<name>` so tests can invoke the plugin's own callbacks directly.
 */
export function fakeContext(directory: string): HookRecorder {
  const hooks = new Map<string, HookCallback[]>()
  const domain = (name: string) => ({
    hook: (hookName: string, callback: HookCallback) => {
      const key = `${name}.${hookName}`
      hooks.set(key, [...(hooks.get(key) ?? []), callback])
      // The real registration also closes over a scope; tests need no finalizers.
      return Effect.succeed({ dispose: () => Effect.void })
    },
  })
  const context = {
    app: { name: "opencode", version: "2.0.26", channel: "test" },
    location: { directory },
    options: {},
    tool: domain("tool"),
    shell: domain("shell"),
    session: domain("session"),
    event: { subscribe: () => Stream.empty },
  }
  return {
    hooks,
    context,
    async fire(key, event) {
      for (const callback of hooks.get(key) ?? []) {
        const result = callback(event)
        if (Effect.isEffect(result)) {
          const exit = await Effect.runPromiseExit(result as Effect.Effect<unknown, unknown>)
          if (Exit.isFailure(exit)) return { event, error: firstFailure(exit.cause) }
        } else {
          await result
        }
      }
      return { event }
    },
  }
}

export async function loadPlugin(recorder: HookRecorder) {
  const module = (await Host.load(yesmemEntry("index.ts"))) as EffectPluginModule
  await Effect.runPromise(module.default.effect(recorder.context) as Effect.Effect<unknown>)
  return module
}
