import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { activationGate } from "./fixture/activation-gate"
import { startServer } from "./fixture/server"

// Agents are registered by plugins (packages/core/src/plugin/agent.ts updates the
// default agent and adds general and explore), and the composer reads the list
// to render its selection. Reading the registry before activation finishes leaves
// the selection without the plugin-provided agents.
it.live(
  "waits for plugin initialization before listing agents",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-endpoint-")))
      const gate = yield* Effect.promise(() => activationGate(tmp.path))
      const server = yield* startServer(tmp.path)
      const url = new URL("/api/agent", server.base)
      url.searchParams.set("location[directory]", tmp.path)

      const observed = yield* Effect.promise(async () => {
        let settled = false
        const pending = fetch(url, { headers: server.headers }).then((response) => {
          settled = true
          return response
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        const early = settled
        await gate.open()
        const response = await pending
        const body: unknown = await response.json()
        return { early, status: response.status, body }
      })

      expect(observed.status).toBe(200)
      expect(observed.early).toBeFalse()
      if (!isRecord(observed.body) || !Array.isArray(observed.body["data"]))
        throw new Error("Expected an agent list response")
      expect(observed.body["data"].map((agent) => (isRecord(agent) ? agent["id"] : undefined))).toContain("general")
    }),
  15_000,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
