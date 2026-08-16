import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { MCPStdio } from "../../src/mcp/stdio"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

function processRunning(pid: number) {
  return Effect.try({
    try: () => process.kill(pid, 0),
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
}

function waitForExit(pids: Set<number>) {
  return pollWithTimeout(
    Effect.forEach(pids, processRunning).pipe(
      Effect.map((running) => (running.every((value) => !value) ? true : undefined)),
    ),
    "stdio transport process was not terminated",
  )
}

function registerCleanup(pids: Set<number>) {
  return Effect.addFinalizer(() =>
    Effect.suspend(() =>
      Effect.forEach(
        pids,
        (pid) =>
          Effect.try({
            try: () => process.kill(pid, "SIGKILL"),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        { discard: true },
      ),
    ),
  )
}

it.live("close is single-flight and notifies onclose exactly once", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const pids = new Set<number>()
    yield* registerCleanup(pids)
    const transport = yield* MCPStdio.make({
      spawner: ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(Effect.tap((handle) => Effect.sync(() => pids.add(Number(handle.pid))))),
      ),
      command: process.execPath,
      args: [fixture],
      cwd: import.meta.dir,
      environment: {},
    })
    const closed = { count: 0 }
    transport.onclose = () => closed.count++

    yield* Effect.promise(transport.start)
    expect(pids.size).toBe(1)
    const first = transport.close()
    const second = transport.close()
    expect(first).toBe(second)
    yield* Effect.promise(() => first)

    yield* waitForExit(pids)
    expect(transport.close()).toBe(first)
    expect(closed.count).toBe(1)
  }),
)

it.live("close waits for a delayed spawn and terminates the resulting process", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const release = yield* Deferred.make<void>()
    const pids = new Set<number>()
    yield* registerCleanup(pids)
    const transport = yield* MCPStdio.make({
      spawner: ChildProcessSpawner.make((command) =>
        Deferred.await(release).pipe(
          Effect.andThen(spawner.spawn(command)),
          Effect.tap((handle) => Effect.sync(() => pids.add(Number(handle.pid)))),
        ),
      ),
      command: process.execPath,
      args: [fixture],
      cwd: import.meta.dir,
      environment: {},
    })
    const closed = { count: 0 }
    transport.onclose = () => closed.count++

    const starting = transport.start()
    const closing = transport.close()
    expect(pids.size).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* Effect.promise(() => Promise.all([starting, closing]))

    expect(pids.size).toBe(1)
    yield* waitForExit(pids)
    expect(closed.count).toBe(1)
  }),
)
