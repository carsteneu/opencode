/** @jsxImportSource @opentui/solid */
/**
 * Shell-first proof: the session route subtree must mount and render frames
 * while pluginHost.start is still pending (ready() === false). pluginHost.start
 * is gated by hand; if the routes were still ready()-gated, the session route
 * would not even be selectable before the gate opens.
 */
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const sessionID = "shell-first"
const session = {
  id: sessionID,
  title: "Shell-first probe",
  slug: "probe",
  projectID: "project",
  directory,
  version: "0.0.0-test",
  time: { created: 0, updated: 0 },
}
const providers = {
  providers: [
    {
      id: "test",
      name: "Test",
      source: "api",
      env: [] as string[],
      options: {},
      models: {
        model: {
          id: "model", providerID: "test", api: { id: "model", url: "http://test", npm: "test" }, name: "Test model",
          capabilities: {
            temperature: false, reasoning: false, attachment: false, toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 100_000, output: 4_096 }, status: "active", options: {}, headers: {},
          release_date: "2026-01-01",
        },
      },
    },
  ],
  default: { test: "model" },
}

test("session route mounts before pluginHost resolves", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fetched = new Set<string>()
  const calls = createFetch((url) => {
    fetched.add(url.pathname)
    if (url.pathname === "/config/providers") return json(providers)
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  })

  let openGate!: () => void
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  let api: TuiPluginApi | undefined
  let stopSlots: (() => void) | undefined
  let task!: Promise<{ epilogue?: string; reason?: unknown }>
  // Skip the StartupLoading overlay so the un-gated route subtree's frames
  // (not the loading screen) are what we sample during the gated window.
  process.env.OPENCODE_FAST_BOOT = "1"
  try {
    const { run } = await import("../../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          // Deliberately never resolves until openGate is called → ready() stays false.
          async start(input) { api = input.api; stopSlots = input.runtime.setupSlots(input.api).dispose; await gate },
          async dispose() { stopSlots?.() },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    // While pluginHost.start is still pending (ready() === false) the app must
    // keep producing frames without crashing. This guards the un-gated route
    // subtree: mounting Session pre-ready must not dead-lock or blow up the
    // error boundary. (Frame content itself is timing-flaky under the batch
    // renderer, so we assert health, not pixels.)
    const deadline = performance.now() + 5_000
    let crashed = false
    while (performance.now() < deadline) {
      if (setup.captureCharFrame().replace(/\x1b\[[0-9;]*m/g, "").includes("opencode crashed")) crashed = true
      if (crashed) break
      await new Promise((r) => setTimeout(r, 10))
    }
    if (crashed) throw new Error("app crashed while pluginHost was still pending")

    openGate()
    const readyDeadline = performance.now() + 15_000
    while (performance.now() < readyDeadline) {
      if (setup.renderer.currentFocusedEditor instanceof TextareaRenderable) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // The -c sentinel route must never issue a session.get for "dummy": that
    // would 404 and navigate home, breaking the continue-redirect.
    expect(fetched.has("/session/dummy"), `fetched ${[...fetched].join(", ")}`).toBe(false)
    expect(setup.renderer.currentFocusedEditor instanceof TextareaRenderable).toBe(true)
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
