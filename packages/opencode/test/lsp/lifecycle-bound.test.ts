import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import * as LSPServer from "@/lsp/server"

function spawnRecordingServer() {
  const serverPath = path.join(__dirname, "recording-lsp-server.js")
  const proc = spawn(process.execPath, [serverPath], { stdio: "pipe" })
  return { process: proc }
}

function makeClient(handle: ReturnType<typeof spawnRecordingServer>, directory: string, openFileLimit?: number) {
  return withTestInstance({
    directory,
    fn: (ctx) =>
      LSPClient.create({
        serverID: "recording",
        server: handle as unknown as LSPServer.Handle,
        root: directory,
        directory,
        instance: ctx,
        openFileLimit,
      }),
  })
}

async function getCounters(client: LSPClient.Info) {
  return client.connection.sendRequest<{
    didOpen: number
    didChange: number
    didClose: number
    versions: number[]
  }>("test/get-counters", {})
}

async function waitFor(probe: () => Promise<boolean> | boolean, timeoutMs = 2_000, stepMs = 25) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error("condition not met within timeout")
}

describe("LSPClient lifecycle bounding", () => {
  test("unchanged re-open of an already-open file sends no didChange and keeps the version", async () => {
    const handle = spawnRecordingServer()
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "a.ts")
    await Bun.write(file, "const a = 1\n")

    const client = await makeClient(handle, tmp.path)

    const v0 = await client.notify.open({ path: file })
    expect(v0).toBe(0)

    // Unmodified on-disk content: no didChange, no version bump, no second didOpen.
    const v1 = await client.notify.open({ path: file })
    expect(v1).toBe(0)

    const counters = await getCounters(client)
    expect(counters.didOpen).toBe(1)
    expect(counters.didChange).toBe(0)
    expect(counters.didClose).toBe(0)

    await client.shutdown()
  })

  test("changed re-open sends exactly one didChange and bumps the version", async () => {
    const handle = spawnRecordingServer()
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "b.ts")
    await Bun.write(file, "const b = 1\n")

    const client = await makeClient(handle, tmp.path)

    expect(await client.notify.open({ path: file })).toBe(0)
    await Bun.write(file, "const b = 2\n")
    expect(await client.notify.open({ path: file })).toBe(1)

    // Unchanged again: version stays 1, didChange stays at exactly one.
    expect(await client.notify.open({ path: file })).toBe(1)

    const counters = await getCounters(client)
    expect(counters.didChange).toBe(1)
    expect(counters.versions).toEqual([0, 1])

    await client.shutdown()
  })

  test("evicting past the LRU cap sends didClose and releases text + diagnostics", async () => {
    const handle = spawnRecordingServer()
    await using tmp = await tmpdir()

    const files = Array.from({ length: 5 }, (_, i) => path.join(tmp.path, `f${i}.ts`))
    await Promise.all(files.map((file) => Bun.write(file, `const f${file} = ${file}\n`)))

    // Small cap so eviction is deterministic.
    const client = await makeClient(handle, tmp.path, 2)

    // Open the first file and seed a push diagnostic for it.
    await client.notify.open({ path: files[0] })
    await client.connection.sendNotification("test/publish-diagnostics", {
      uri: pathToFileURL(files[0]).href,
      version: 0,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: "evict me",
          severity: 1,
        },
      ],
    })
    await waitFor(() => (client.diagnostics.get(files[0])?.length ?? 0) > 0)

    for (let i = 1; i < files.length; i++) {
      await client.notify.open({ path: files[i] })
    }

    // Opening f0..f4 with a cap of 2 must have evicted at least 3 documents.
    await waitFor(async () => (await getCounters(client)).didClose >= 3)
    const counters = await getCounters(client)
    expect(counters.didClose).toBeGreaterThanOrEqual(3)

    // The LRU (f0) was evicted first: its diagnostics must be released.
    expect(client.diagnostics.has(files[0])).toBe(false)

    // Re-opening an evicted file behaves like a fresh open (didOpen, version 0).
    const v = await client.notify.open({ path: files[0] })
    expect(v).toBe(0)
    await waitFor(async () => (await getCounters(client)).didOpen >= 6)
    expect((await getCounters(client)).didOpen).toBeGreaterThanOrEqual(6)

    await client.shutdown()
  })

  test("diagnosticsFor scopes the merged map to the requested files", async () => {
    const handle = spawnRecordingServer()
    await using tmp = await tmpdir()
    const a = path.join(tmp.path, "a.ts")
    const b = path.join(tmp.path, "b.ts")
    await Bun.write(a, "const a = 1\n")
    await Bun.write(b, "const b = 1\n")

    const client = await makeClient(handle, tmp.path)

    await client.notify.open({ path: a })
    await client.notify.open({ path: b })

    const push = (file: string) =>
      client.connection.sendNotification("test/publish-diagnostics", {
        uri: pathToFileURL(file).href,
        version: 0,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: `diag ${file}`,
            severity: 1,
          },
        ],
      })
    await push(a)
    await push(b)
    await waitFor(() => client.diagnostics.size >= 2)

    const scoped = client.diagnosticsFor([a])
    expect(scoped.has(a)).toBe(true)
    expect(scoped.has(b)).toBe(false)
    expect(scoped.get(a)?.[0]?.message).toContain(`diag ${a}`)

    await client.shutdown()
  })
})
