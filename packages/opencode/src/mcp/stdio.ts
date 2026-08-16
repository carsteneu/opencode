export * as MCPStdio from "./stdio"

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Duration, Effect, Exit, Queue, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const CLOSE_GRACE = Duration.millis(500)
const FORCE_KILL_AFTER = Duration.millis(500)
const OUTGOING_CAPACITY = 64
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export interface Options {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Record<string, string>
  readonly onClosed?: (transport: Transport) => void
}

/**
 * MCP stdio transport backed by the process spawner used by OpenCode.
 *
 * Every connection owns a closeable scope independent of the request that happened to start it.
 * Closing the transport drains that scope after stdin and the full process tree have been stopped.
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const scope = yield* Scope.make()
  const outgoing = yield* Queue.bounded<string, Cause.Done>(OUTGOING_CAPACITY)
  const buffer = new ReadBuffer()
  const state: { phase: "ready" | "starting" | "open" | "closed"; handle?: ChildProcessHandle } = {
    phase: "ready",
  }
  let startup: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let notified = false
  let trailingBytes = 0

  const stopPosix = Effect.fnUntraced(function* (handle: ChildProcessHandle) {
    yield* Effect.timeoutOption(Effect.exit(handle.exitCode), CLOSE_GRACE)

    const started = Date.now()
    const terminated = yield* handle
      .kill({ killSignal: "SIGTERM" })
      .pipe(Effect.timeoutOption(FORCE_KILL_AFTER), Effect.exit)

    // The handle tracks the root process, not the detached process group. If the root exits after
    // SIGTERM, descendants can still be alive, so keep the full grace period and always address the
    // group with SIGKILL afterwards.
    if (Exit.isSuccess(terminated) && terminated.value._tag === "Some") {
      const remaining = Duration.toMillis(FORCE_KILL_AFTER) - (Date.now() - started)
      if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining))
    }
    yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
  })

  const stopWindows = (handle: ChildProcessHandle) =>
    // CrossSpawnSpawner implements handle.kill with taskkill /T /F on Windows. Run it before stdin
    // can let the root disappear, because taskkill needs that root PID to find the whole tree.
    handle.kill({ killSignal: "SIGTERM", forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore)

  const notifyClose = () => {
    if (notified) return
    notified = true
    options.onClosed?.(transport)
    transport.onclose?.()
  }

  const close = () => {
    if (closing) return closing
    state.phase = "closed"
    closing = Effect.runPromise(
      Effect.gen(function* () {
        if (startup) yield* Effect.promise(() => startup!.catch(() => undefined))

        const handle = state.handle
        state.handle = undefined
        if (handle && process.platform === "win32") yield* stopWindows(handle)

        Queue.endUnsafe(outgoing)

        if (handle && process.platform !== "win32") yield* stopPosix(handle)
      }).pipe(
        Effect.ensuring(Queue.shutdown(outgoing)),
        Effect.ensuring(Effect.sync(() => buffer.clear())),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(Effect.sync(notifyClose)),
      ),
    )
    return closing
  }

  const transport: Transport = {
    start: () => {
      if (state.phase !== "ready") return Promise.reject(new Error("Stdio transport already started"))
      state.phase = "starting"
      startup = Effect.runPromise(
        Effect.gen(function* () {
          const handle = yield* options.spawner.spawn(
            ChildProcess.make(options.command, [...options.args], {
              cwd: options.cwd,
              env: options.environment,
              extendEnv: true,
              detached: process.platform !== "win32",
              stdin: { stream: Stream.encodeText(Stream.fromQueue(outgoing)), endOnDone: true },
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )
          state.handle = handle
          if (state.phase === "closed") return
          state.phase = "open"
          yield* startOutput(handle)
        }).pipe(Scope.provide(scope)),
      )
      return startup
    },
    send: (message: JSONRPCMessage) =>
      state.phase !== "open"
        ? Promise.reject(new Error("Not connected"))
        : Effect.runPromise(
            Queue.offer(outgoing, serializeMessage(message)).pipe(
              Effect.flatMap((offered) => (offered ? Effect.void : Effect.fail(new Error("Not connected")))),
            ),
          ),
    close,
  }

  const deliver = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      for (const byte of chunk) {
        trailingBytes = byte === 10 ? 0 : trailingBytes + 1
        if (trailingBytes > MAX_FRAME_BYTES) return yield* Effect.fail(new Error("MCP stdio frame exceeded 16 MiB"))
      }

      buffer.append(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      while (true) {
        const message = yield* Effect.try({
          try: () => buffer.readMessage(),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              transport.onerror?.(error)
              return undefined
            }),
          ),
        )
        if (message === undefined) continue
        if (message === null) return
        transport.onmessage?.(message)
      }
    })

  const startOutput = (handle: ChildProcessHandle) =>
    Effect.gen(function* () {
      yield* Stream.runForEach(handle.stdout, deliver).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }),
        ),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (state.phase !== "closed") void close()
            notifyClose()
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      // Raw draining avoids both pipe backpressure and a per-chunk logging/string-allocation storm.
      yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

  return transport
})
