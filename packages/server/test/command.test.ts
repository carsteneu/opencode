import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { activationGate } from "./fixture/activation-gate"
import { startServer } from "./fixture/server"

// The command registry is filled by plugins (packages/core/src/plugin/command.ts
// adds init and review, and session entry points already wait for activation in
// packages/core/src/session/command.ts). The HTTP handler has to wait as well,
// otherwise a cold location answers with an empty list that clients cache.
it.live(
  "waits for plugin initialization before listing commands",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-command-endpoint-")))
      const gate = yield* Effect.promise(() => activationGate(tmp.path))
      const server = yield* startServer(tmp.path)
      const url = new URL("/api/command", server.base)
      url.searchParams.set("location[directory]", tmp.path)

      const observed = yield* Effect.promise(async () => {
        let settled = false
        const pending = fetch(url, { headers: server.headers }).then((response) => {
          settled = true
          return response
        })
        // Give an unguarded handler every chance to answer first, then release
        // activation and collect the response either way.
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
        throw new Error("Expected a command list response")
      expect(observed.body["data"].map((command) => (isRecord(command) ? command["name"] : undefined))).toContain("init")
    }),
  15_000,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
