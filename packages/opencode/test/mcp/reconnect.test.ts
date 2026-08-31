import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as TestClock from "effect/testing/TestClock"
import { Effect } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, EventV2Bridge.node])))

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

const hint = (status: MCP.Status | undefined) => (status?.status === "failed" ? /retry \d+\/100/.test(status.error) : false)

function waitForStatus(
  mcp: MCP.Service,
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

it.instance(
  "reconnects automatically once a failed server becomes reachable",
  () =>
    Effect.gen(function* () {
      const server = retryServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("retry-server", remote(server.url))
      yield* waitForStatus(
        mcp,
        "retry-server",
        (status) => status?.status === "failed" && hint(status),
        "failed status with retry hint expected",
      )

      yield* Effect.promise(server.start)
      yield* TestClock.adjust("12 seconds")
      const status = yield* waitForStatus(mcp, "retry-server", (s) => s?.status === "connected", "server did not reconnect")
      expect(status?.status).toBe("connected")
      expect(Object.keys(yield* mcp.tools())).toEqual(["retry-server_retry_tool"])
      yield* mcp.disconnect("retry-server")
    }),
)

it.instance(
  "schedules a reconnect episode when a connection closes",
  () =>
    Effect.gen(function* () {
      const server = retryServer()
      const mcp = yield* MCP.Service
      yield* Effect.promise(server.start)
      yield* mcp.add("close-server", remote(server.url))
      yield* Effect.promise(server.close)
      yield* waitForStatus(
        mcp,
        "close-server",
        (status) => status?.status === "failed" && hint(status),
        "reconnect episode should be scheduled after close",
      )

      yield* TestClock.adjust("12 seconds")
      const status = yield* waitForStatus(
        mcp,
        "close-server",
        (s) => s?.status === "failed" && /retry 2\/100/.test(s.error),
        "second reconnect attempt should be scheduled",
      )
      expect(status?.status).toBe("failed")
      yield* mcp.disconnect("close-server")
    }),
)

it.instance("gives up after 100 reconnect attempts", () =>
  Effect.gen(function* () {
    const server = retryServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("giveup-server", remote(server.url))
    yield* waitForStatus(
      mcp,
      "giveup-server",
      (status) => status?.status === "failed" && hint(status),
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
      (status) => status?.status === "failed" && !hint(status),
      "final status should be plain failed without retry hint",
    )
  }),
)

it.instance("disconnect cancels the reconnect episode", () =>
  Effect.gen(function* () {
    const server = retryServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("cancelled-server", remote(server.url))
    yield* waitForStatus(
      mcp,
      "cancelled-server",
      (status) => status?.status === "failed" && hint(status),
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
  }),
)
