import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const session = {
  id: "ses_tool_progress",
  title: "Tool input progress",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 10 },
}

const messages: SessionMessageInfo[] = [
  { type: "user", id: "user_1", text: "write the file", time: { created: 0 } },
  {
    type: "assistant",
    id: "assistant_1",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool_write",
        name: "write",
        time: { created: 2 },
        state: { status: "streaming", input: '{"path":"a.txt"', received: 2048 },
      },
    ],
  },
] as unknown as SessionMessageInfo[]

test("a streaming write reports the bytes received so far in its pending label", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run: runApp } = await import("../src/app")
  const task = Effect.runPromise(
    runApp({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { enabled: false }, session: { verbosity: "medium" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("write the file"))
    await setup.waitForFrame((frame) => frame.includes("2 KB received"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Preparing write…")
    expect(frame).toContain("(2 KB received)")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 30000)
