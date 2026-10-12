import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Host } from "@opencode/plugin/host"

// The plugin lives outside every tsconfig project (deliberate: plugin sources are runtime files, see
// .opencode/plugin-suite/). Tests therefore reach it through the real host loader with local type declarations,
// mirroring packages/tui/test/plugin-*.test.tsx.

type RpcResponse = { ok: boolean; result?: any; error?: string }

type Module = {
  default: { id: string; setup: (context: unknown) => unknown }
}

type RpcModule = {
  YesMemRPC: new (socketPath?: string) => {
    call: (method: string, params?: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<RpcResponse>
  }
}

const entry = (file: string) =>
  new URL(`../../../../.opencode/plugin-suite/opencode-yesmem/${file}`, import.meta.url).href

async function mockDaemon(handler: (request: any) => unknown | undefined) {
  const directory = await mkdtemp(path.join(tmpdir(), "yesmem-daemon-"))
  const socketPath = path.join(directory, "daemon.sock")
  const requests: any[] = []
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
        const request = JSON.parse(line)
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
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe("yesmem plugin module contract", () => {
  test("the entrypoint exports a default definition with an id and a setup function", async () => {
    const module = (await Host.load(entry("index.ts"))) as Module
    expect(module.default.id).toBe("opencode.yesmem")
    expect(typeof module.default.setup).toBe("function")
  })
})

describe("yesmem daemon RPC transport", () => {
  test("sends one JSON request line and unwraps the daemon result wrapper", async () => {
    const daemon = await mockDaemon((request) => ({ result: { method: request.method, echoed: request.params } }))
    try {
      const { YesMemRPC } = (await Host.load(entry("rpc.ts"))) as RpcModule
      const rpc = new YesMemRPC(daemon.socketPath)

      const response = await rpc.call("remember", { text: "hi" })

      expect(response).toEqual({ ok: true, result: { method: "remember", echoed: { text: "hi" } } })
      expect(daemon.requests).toEqual([{ method: "remember", params: { text: "hi" } }])
    } finally {
      await daemon.close()
    }
  })

  test("defaults params to an empty object", async () => {
    const daemon = await mockDaemon(() => ({ result: "pong" }))
    try {
      const { YesMemRPC } = (await Host.load(entry("rpc.ts"))) as RpcModule
      const response = await new YesMemRPC(daemon.socketPath).call("ping")

      expect(response).toEqual({ ok: true, result: "pong" })
      expect(daemon.requests).toEqual([{ method: "ping", params: {} }])
    } finally {
      await daemon.close()
    }
  })

  test("reports a daemon error response as ok:false", async () => {
    const daemon = await mockDaemon(() => ({ error: "unknown method: nope" }))
    try {
      const { YesMemRPC } = (await Host.load(entry("rpc.ts"))) as RpcModule
      const response = await new YesMemRPC(daemon.socketPath).call("nope")

      expect(response.ok).toBe(false)
      expect(response.error).toContain("unknown method: nope")
    } finally {
      await daemon.close()
    }
  })

  test("reports a missing socket as ok:false instead of throwing", async () => {
    const { YesMemRPC } = (await Host.load(entry("rpc.ts"))) as RpcModule
    const response = await new YesMemRPC(path.join(tmpdir(), "yesmem-absent", "daemon.sock")).call("ping")

    expect(response.ok).toBe(false)
    expect(response.error).toBeTruthy()
  })

  test("bounds a silent daemon with the configured timeout", async () => {
    const daemon = await mockDaemon(() => undefined)
    try {
      const { YesMemRPC } = (await Host.load(entry("rpc.ts"))) as RpcModule
      const started = Date.now()
      const response = await new YesMemRPC(daemon.socketPath).call("ping", {}, { timeoutMs: 200 })

      expect(response.ok).toBe(false)
      expect(response.error).toContain("timeout")
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await daemon.close()
    }
  })
})
