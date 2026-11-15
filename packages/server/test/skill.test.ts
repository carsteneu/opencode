import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { activationGate } from "./fixture/activation-gate"
import { serveRoutes } from "./fixture/routes"

it.live("lists configured skills", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-skill-endpoint-")))
    yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "skills", "demo"), { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo skill\n---\nbody\n",
      ),
    )
    yield* Effect.promise(() =>
      fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ skills: [path.join(tmp.path, "skills")] })),
    )
    const server = yield* serveRoutes({
      database: { path: ":memory:" },
      config: { directory: tmp.path },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    yield* server.pluginsLoaded(tmp.path)
    const url = new URL("/api/skill", "http://opencode.local")
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() => server.fetch(url))

    expect(response.status).toBe(200)
    const body: unknown = yield* Effect.promise(() => response.json())
    if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Expected a skill list response")
    expect(body["data"].some((skill) => isRecord(skill) && skill["name"] === "demo")).toBeTrue()
  }),
)

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
