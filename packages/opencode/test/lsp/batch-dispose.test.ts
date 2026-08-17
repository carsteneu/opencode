import { describe, expect, test, spyOn } from "bun:test"
import { spawn } from "child_process"
import { writeFile } from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as LSPServer from "@/lsp/server"
import { LSP } from "@/lsp/lsp"
import { provideInstanceEffect, testInstanceStoreLayer, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LSP.node))

function spawnRecordingServer() {
  const serverPath = path.join(__dirname, "recording-lsp-server.js")
  const proc = spawn(process.execPath, [serverPath], { stdio: "pipe" })
  ;(proc.stderr as unknown as NodeJS.ReadableStream)?.resume()
  return { process: proc }
}

// Issues a raw JSON-RPC request after the LSP client is idle and resolves with
// the result. The client's reader leaves frames for unknown ids untouched.
function rawRequest(
  handle: { process: import("child_process").ChildProcessWithoutNullStreams },
  method: string,
  params?: unknown,
) {
  return new Promise<any>(async (resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 1e6)
    const json = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      let idx
      while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
        const header = buffer.slice(0, idx).toString("utf8")
        const m = /Content-Length:\s*(\d+)/i.exec(header)
        const length = m ? parseInt(m[1], 10) : 0
        const bodyStart = idx + 4
        const bodyEnd = bodyStart + length
        if (buffer.length < bodyEnd) break
        const body = buffer.slice(bodyStart, bodyEnd).toString("utf8")
        buffer = buffer.slice(bodyEnd)
        let msg
        try {
          msg = JSON.parse(body)
        } catch {
          continue
        }
        if (msg.id === id) {
          handle.process.stdout.off("data", onData)
          resolve(msg.result)
          return
        }
      }
    }
    handle.process.stdout.on("data", onData)
    const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
    handle.process.stdin.write(frame)
    setTimeout(() => {
      handle.process.stdout.off("data", onData)
      reject(new Error("rawRequest timeout"))
    }, 2_000)
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("LSP batch open bounding (item 4)", () => {
  it.instance(
    "touchFiles opens N files in parallel under one overall deadline instead of N serial waits",
    () =>
      Effect.gen(function* () {
        const handle = spawnRecordingServer()
        const spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(handle as any)

        const test = yield* TestInstance
        const n = 8
        const files = Array.from({ length: n }, (_, i) => path.join(test.directory, `b${i}.ts`))
        for (let i = 0; i < n; i++) {
          const file = files[i]
          yield* Effect.promise(() => Bun.write(file, `const x${i} = 1\n`))
        }

        // Each file's diagnostics take 2000ms to come back. A serial loop would
        // cost n * 2s = 16s here. The batch must run the opens concurrently and bound
        // the whole pass, so it returns near the single-file delay (~2s), far under
        // serial (16s).
        yield* Effect.promise(() => rawRequest(handle, "test/configure-delay", { diagnosticDelayMs: 2000 }))

        const lsp = yield* LSP.Service
        const started = Date.now()
        if (lsp.touchFiles) yield* lsp.touchFiles(files, "document")
        const elapsed = Date.now() - started

        // Proves: not serial (16s), and bounded far under it — only the overall
        // deadline (15s) or true parallelism can return this fast.
        expect(elapsed).toBeLessThan(12_000)
        // And it actually waited for the diagnostics rather than short-circuiting.
        expect(elapsed).toBeGreaterThanOrEqual(2_000)

        // Read counters while the instance is still alive (before the harness
        // disposes it and tears down the LSP connection).
        const counters = yield* Effect.promise(() => rawRequest(handle, "test/get-counters"))
        expect(counters.didOpen).toBe(n)

        spawnSpy.mockRestore()
      }),
    { config: { lsp: true } },
  )
})

describe("LSP dispose and subprocess teardown (item 6)", () => {
  let postDisposeCheck: (() => boolean) | null = null

  it.instance(
    "a registered client is alive before the instance disposes",
    () =>
      Effect.gen(function* () {
        const handle = spawnRecordingServer()
        const spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(handle as any)
        postDisposeCheck = () => handle.process.exitCode !== null || handle.process.killed

        const test = yield* TestInstance
        const lsp = yield* LSP.Service
        const file = path.join(test.directory, "a.ts")
        yield* Effect.promise(() => Bun.write(file, "const a = 1\n"))
        yield* lsp.touchFile(file, "document")
        // Fully registered and running before the harness disposes the instance.
        expect(handle.process.exitCode).toBeNull()
        spawnSpy.mockRestore()
      }),
    { config: { lsp: true } },
  )

  test("disposing the instance kills the spawned LSP subprocess (no orphan)", () => {
    // Runs after the it.instance above has fully completed, including the
    // instance dispose + client shutdown.
    expect(postDisposeCheck?.()).toBe(true)
  })

  test("a gated spawn resolved after dispose is shut down, not registered/orphaned", async () => {
    const handle = spawnRecordingServer()
    let resolveSpawn!: (h: unknown) => void
    const gate = new Promise<any>((resolve) => (resolveSpawn = resolve))
    const spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockImplementation(
      () => gate as unknown as Promise<LSPServer.Handle | undefined>,
    )

    // Build an isolated LSP layer (fresh memoMap, so it is independent of any
    // other test in the shared suite) into a scope we own, so we can dispose it
    // while a gated spawn is still in flight.
    const layer = LayerNode.compile(LSP.node)
    const scope = await Effect.runPromise(Scope.make())
    const freshMemoMap = Layer.makeMemoMapUnsafe()
    const ctx = await Effect.runPromise(Layer.buildWithMemoMap(layer, freshMemoMap, scope))

    await using tmp = await tmpdir()
    const dir = tmp.path
    await writeFile(path.join(dir, "gated.ts"), "const gated = 1\n")
    // Enable LSP servers in this instance's own config so the Typescript server
    // is registered when provideInstanceEffect loads the project.
    await writeFile(path.join(dir, "opencode.json"), JSON.stringify({ lsp: true }))

    // Fire-and-forget: the gated touchFile runs on its own fiber that survives
    // our later explicit disposal, so its spawn lands after dispose.
    const bg = Effect.runPromise(
      Effect.gen(function* () {
        const lsp = yield* LSP.Service
        yield* lsp.touchFile(path.join(dir, "gated.ts"), "document")
      }).pipe(Effect.provide(ctx), provideInstanceEffect(dir), Effect.provide(testInstanceStoreLayer)),
    )
      .then(() => {})
      .catch(() => {})

    await wait(250)
    expect(spawnSpy).toHaveBeenCalled()

    // Dispose now; the LSP finalizer sets the disposed flag while the spawn is
    // still in flight.
    await Effect.runPromise(Scope.close(scope, Exit.void))

    // Complete the gated spawn after dispose. The guard must shut the freshly
    // built client down instead of registering it, so no process is orphaned.
    resolveSpawn(handle)
    await wait(700)
    await bg

    const killed = handle.process.exitCode !== null || handle.process.killed
    expect(killed).toBe(true)

    spawnSpy.mockRestore()
  })
})
