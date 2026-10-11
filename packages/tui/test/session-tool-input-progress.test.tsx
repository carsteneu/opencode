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

const TOOL_ID = "tool_write"
const ASSISTANT_ID = "assistant_1"

function messages(received?: number): SessionMessageInfo[] {
  return [
    { type: "user", id: "user_1", text: "write the file", time: { created: 0 } },
    {
      type: "assistant",
      id: ASSISTANT_ID,
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: TOOL_ID,
          name: "write",
          time: { created: 2 },
          state: { status: "streaming", input: '{"path":"a.txt"', ...(received === undefined ? {} : { received }) },
        },
      ],
    },
  ] as unknown as SessionMessageInfo[]
}

async function withSession(
  received: number | undefined,
  run: (setup: Awaited<ReturnType<typeof createTestRenderer>>, events: ReturnType<typeof createEventStream>) => Promise<void>,
) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const fixture = messages(received)
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: fixture.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
    return undefined
  }, events)
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
    await setup.waitForFrame((frame) => frame.includes("Preparing write…"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    await run(setup, events)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

test("a streaming write reports the bytes received so far in its pending label", async () => {
  await withSession(2048, async (setup) => {
    await setup.waitForFrame((frame) => frame.includes("2 KB received"))
    expect(setup.captureCharFrame()).toContain("(2 KB received)")
  })
}, 30000)

test("a live progress event updates the pending label of a streaming tool", async () => {
  await withSession(undefined, async (setup, events) => {
    expect(setup.captureCharFrame()).not.toContain("received)")

    events.emit({
      id: "evt_progress",
      created: 300,
      type: "session.tool.input.progress",
      location: { directory },
      data: { sessionID: session.id, assistantMessageID: ASSISTANT_ID, id: TOOL_ID, received: 5120 },
    })

    await setup.waitForFrame((frame) => frame.includes("5 KB received"))
    expect(setup.captureCharFrame()).toContain("(5 KB received)")
  })
}, 30000)
