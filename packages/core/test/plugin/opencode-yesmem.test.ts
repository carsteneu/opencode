import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { Host } from "@opencode/plugin/host"
import { mockDaemon, yesmemEntry, type EffectPluginModule, type RpcResponse } from "./opencode-yesmem-fixture"

type RpcModule = {
  YesMemRPC: new (socketPath?: string) => {
    call: (method: string, params?: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<RpcResponse>
  }
}

describe("yesmem plugin module contract", () => {
  test("the entrypoint exports a default definition with an id and an effect", async () => {
    const module = (await Host.load(yesmemEntry("index.ts"))) as EffectPluginModule
    expect(module.default.id).toBe("opencode.yesmem")
    expect(typeof module.default.effect).toBe("function")
  })
})

describe("yesmem daemon RPC transport", () => {
  test("sends one JSON request line and unwraps the daemon result wrapper", async () => {
    const daemon = await mockDaemon((request) => ({ result: { method: request.method, echoed: request.params } }))
    try {
      const { YesMemRPC } = (await Host.load(yesmemEntry("rpc.ts"))) as RpcModule
      const response = await new YesMemRPC(daemon.socketPath).call("remember", { text: "hi" })

      expect(response).toEqual({ ok: true, result: { method: "remember", echoed: { text: "hi" } } })
      expect(daemon.requests).toEqual([{ method: "remember", params: { text: "hi" } }])
    } finally {
      await daemon.close()
    }
  })

  test("defaults params to an empty object", async () => {
    const daemon = await mockDaemon(() => ({ result: "pong" }))
    try {
      const { YesMemRPC } = (await Host.load(yesmemEntry("rpc.ts"))) as RpcModule
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
      const { YesMemRPC } = (await Host.load(yesmemEntry("rpc.ts"))) as RpcModule
      const response = await new YesMemRPC(daemon.socketPath).call("nope")

      expect(response.ok).toBe(false)
      expect(response.error).toContain("unknown method: nope")
    } finally {
      await daemon.close()
    }
  })

  test("reports a missing socket as ok:false instead of throwing", async () => {
    const { YesMemRPC } = (await Host.load(yesmemEntry("rpc.ts"))) as RpcModule
    const response = await new YesMemRPC(path.join(tmpdir(), "yesmem-absent", "daemon.sock")).call("ping")

    expect(response.ok).toBe(false)
    expect(response.error).toBeTruthy()
  })

  test("bounds a silent daemon with the configured timeout", async () => {
    const daemon = await mockDaemon(() => undefined)
    try {
      const { YesMemRPC } = (await Host.load(yesmemEntry("rpc.ts"))) as RpcModule
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
