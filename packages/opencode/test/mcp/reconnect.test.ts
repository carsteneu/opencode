import { expect } from "bun:test"
import path from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as TestClock from "effect/testing/TestClock"
import { Effect } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MCP } from "../../src/mcp/index"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, EventV2Bridge.node])))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

// Same band table as packages/opencode/src/mcp/index.ts
const retryBand = (attempt: number) =>
  attempt <= 10 ? 10_000 : attempt <= 20 ? 100_000 : attempt <= 30 ? 600_000 : attempt <= 40 ? 3_600_000 : 21_600_000

// Binds and releases a port once so a server can be brought up later on it.
function retryServer() {
  const held: { protocol?: Server; http?: ReturnType<typeof Bun.serve> } = {}
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port
  probe.stop(true)
  async function start() {
    const protocol = new Server({ name: "mcp-retry", version: "1.0.0" }, { capabilities: { tools: {} } })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    protocol.setRequestHandler(
      ListToolsRequestSchema,
      () =>
        Promise.resolve({
          tools: [{ name: "retry_tool", description: "retry tool", inputSchema: { type: "object", properties: {} } }],
        }),
    )
    await protocol.connect(transport)
    held.protocol = protocol
    held.http = Bun.serve({ port, fetch: (request) => transport.handleRequest(request) })
  }
  async function close() {
    await held.protocol?.close().catch(() => {})
    held.http?.stop(true)
  }
  return { url: `http://127.0.0.1:${port}`, start, close }
}

const retryHint = (status: MCP.Status | undefined) =>
  status?.status === "failed" ? /retry \d+\/100/.test(status.error) : false

function waitForStatus(
  mcp: MCP.Interface,
  name: string,
  predicate: (status: MCP.Status | undefined) => boolean,
  message: string,
) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 5000
    while (true) {
      const status = (yield* mcp.status())[name]
      if (predicate(status)) return status
      if (Date.now() > deadline) throw new Error(`${message}: last=${JSON.stringify(status)}`)
      yield* Effect.promise(() => Bun.sleep(25))
    }
  })
}

it.effect(
  "reconnects automatically once a failed server becomes reachable",
  () =>
    Effect.gen(function* () {
      const server = retryServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("retry-server", remote(server.url))
      yield* waitForStatus(
        mcp,
        "retry-server",
        (status) => status?.status === "failed" && retryHint(status),
        "failed status with retry hint expected",
      )

      yield* Effect.promise(server.start)
      yield* TestClock.adjust("12 seconds")
      const status = yield* waitForStatus(mcp, "retry-server", (s) => s?.status === "connected", "server did not reconnect")
      expect(status?.status).toBe("connected")
      expect(Object.keys(yield* mcp.tools())).toEqual(["retry-server_retry_tool"])
      yield* mcp.disconnect("retry-server")
    }).pipe(withTmpdirInstance()),
)

it.effect(
  "schedules a reconnect episode when a connection closes",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const pidFile = path.join(instance.directory, "stdio-server.pid")
      const mcp = yield* MCP.Service
      yield* mcp.add("close-server", {
        type: "local" as const,
        command: [process.execPath, stdioFixture],
        environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      })
      yield* waitForStatus(mcp, "close-server", (s) => s?.status === "connected", "expected connected stdio server")

      yield* Effect.promise(async () => process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL"))
      yield* waitForStatus(
        mcp,
        "close-server",
        (status) => status?.status === "failed" && retryHint(status),
        "reconnect episode should be scheduled after close",
      )

      yield* TestClock.adjust("12 seconds")
      const status = yield* waitForStatus(mcp, "close-server", (s) => s?.status === "connected", "server did not reconnect")
      expect(status?.status).toBe("connected")
      expect(Object.keys(yield* mcp.tools())).toEqual(["close-server_current_directory"])
      yield* mcp.disconnect("close-server")
    }).pipe(withTmpdirInstance()),
)

it.effect(
  "gives up after 100 reconnect attempts",
  () =>
    Effect.gen(function* () {
      const server = retryServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("giveup-server", remote(server.url))
      yield* waitForStatus(
        mcp,
        "giveup-server",
        (status) => status?.status === "failed" && retryHint(status),
        "reconnect episode should be scheduled",
      )

      let gaveUp = false
      for (let round = 0; round < 300; round++) {
        const status = (yield* mcp.status())["giveup-server"]
        const attempt = status?.status === "failed" ? /retry (\d+)\/100/.exec(status.error)?.[1] : undefined
        if (attempt === undefined) {
          gaveUp = true
          break
        }
        yield* TestClock.adjust(retryBand(Number(attempt)) * 1.2)
      }
      expect(gaveUp).toBe(true)
      yield* waitForStatus(
        mcp,
        "giveup-server",
        (status) => status?.status === "failed" && !retryHint(status),
        "final status should be plain failed without retry hint",
      )
      yield* mcp.disconnect("giveup-server")
    }).pipe(withTmpdirInstance()),
)

it.effect(
  "disconnect cancels the reconnect episode",
  () =>
    Effect.gen(function* () {
      const server = retryServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("cancelled-server", remote(server.url))
      yield* waitForStatus(
        mcp,
        "cancelled-server",
        (status) => status?.status === "failed" && retryHint(status),
        "reconnect episode should be scheduled",
      )

      yield* mcp.disconnect("cancelled-server")
      yield* TestClock.adjust("12 seconds")
      yield* waitForStatus(
        mcp,
        "cancelled-server",
        (status) => status?.status === "disabled",
        "status should stay disabled after disconnect",
      )
      yield* TestClock.adjust("12 seconds")
      expect((yield* mcp.status())["cancelled-server"]?.status).toBe("disabled")
    }).pipe(withTmpdirInstance()),
)
