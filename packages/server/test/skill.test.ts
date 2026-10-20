import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { activationGate } from "./fixture/activation-gate"
import { startServer } from "./fixture/server"

// Skills are registered by plugins (packages/core/src/plugin/skill.ts adds the
// builtin opencode and report skills), and session entry points wait for that
// activation (packages/core/src/session/skill.ts). The list endpoint must wait
// too, or a cold location reports no skills at all.
it.live(
  "waits for plugin initialization before listing skills",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-skill-endpoint-")))
      const gate = yield* Effect.promise(() => activationGate(tmp.path))
      const server = yield* startServer(tmp.path)
      const url = new URL("/api/skill", server.base)
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
        throw new Error("Expected a skill list response")
      expect(observed.body["data"].map((skill) => (isRecord(skill) ? skill["id"] : undefined))).toContain("opencode")
    }),
  15_000,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
