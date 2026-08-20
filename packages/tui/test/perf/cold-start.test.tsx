/** @jsxImportSource @opentui/solid */
/**
 * Loop A — OpenCode-Praxistest: Cold-Start → Input-Ready Latenz.
 *
 * Bootet die echte OpenCode-TUI offline und misst die Zeit von run() bis die
 * Session-Route erreicht ist und das Prompt-Textarea fokussiert gerendert wurde.
 * Ein Prozess pro Messwert: Aufruf über Bash-Loop `bun test ...` → frische Samples.
 * Ausgabe: "[RESULT] cold_start_ms=NN.N" für die A/B-Aggregation.
 * HINWEIS: misst den Dev-Transpile-Pfad (lazy imports werden von bun hier inline),
 * kein Abbild des Produktions-Bundles — als konsistente A/B-Basis gedacht.
 */
import { mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const sessionID = "dummy"
const session = {
  id: sessionID,
  title: "Probe session",
  slug: "probe",
  projectID: "project",
  directory,
  version: "0.0.0-test",
  time: { created: 0, updated: 0 },
}
const model = {
  id: "model",
  providerID: "test",
  api: { id: "model", url: "http://test", npm: "test" },
  name: "Test model",
  capabilities: {
    temperature: false, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 4_096 },
  status: "active", options: {}, headers: {}, release_date: "2026-01-01",
}

test("cold start to input-ready", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, gatherStats: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers")
      return json({ providers: [{ id: "test", name: "Test", source: "api", env: [], options: {}, models: { model } }], default: { test: "model" } })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let api: TuiPluginApi | undefined
  let stopSlots: (() => void) | undefined

  try {
    const t0 = performance.now()
    const { run } = await import("../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) { api = input.api; stopSlots = input.runtime.setupSlots(input.api).dispose; started() },
          async dispose() { stopSlots?.() },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.waitFor(() => {
      const tui = api!
      if (tui.route.current.name !== "session") return false
      if (!(setup.renderer.currentFocusedEditor instanceof TextareaRenderable)) return false
      return [...tui.keymap.getCommandBindings({ visibility: "active", commands: ["session.first", "input.buffer.home"] }).values()].every((items) => items.length > 0)
    })
    const ms = (performance.now() - t0).toFixed(2)
    console.log(`[RESULT] cold_start_ms=${ms}`)

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
