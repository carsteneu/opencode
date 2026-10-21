import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>
type Events = ReturnType<typeof createEventStream>

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const parent = {
  id: "ses_agents_parent",
  title: "Agents parent",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens,
  time: { created: 0, updated: 1 },
}
const child = {
  ...parent,
  id: "ses_agents_child",
  parentID: parent.id,
  title: "Probe render path (@explore subagent)",
  time: { created: 10, updated: 20 },
}

const ASSISTANT_ID = "assistant_1"
const SUBAGENT_PART_ID = "tool_subagent"

const messages: SessionMessageInfo[] = [
  { type: "user", id: "user_1", text: "delegate this", time: { created: 0 } },
  {
    type: "assistant",
    id: ASSISTANT_ID,
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [
      { type: "text", id: "text_1", text: "Delegating. ", time: { created: 1 } },
      {
        type: "tool",
        id: SUBAGENT_PART_ID,
        name: "subagent",
        time: { created: 2 },
        state: { status: "running", input: {}, metadata: { sessionID: child.id } },
      },
    ],
  },
] as unknown as SessionMessageInfo[]

async function withSession(run: (setup: Setup, events: Events) => Promise<void>) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  setup.renderer.start()
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session")
      return json({ data: url.searchParams.get("parentID") ? [child] : [parent, child], cursor: {} })
    if (url.pathname === `/api/session/${parent.id}`) return json({ data: parent })
    if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
    if (url.pathname === `/api/session/${parent.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run: runApp } = await import("../src/app")
  const task = Effect.runPromise(
    runApp({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { enabled: false }, session: { verbosity: "low" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: parent.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("1/1 active"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    await run(setup, events)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

const lines = (frame: string) => frame.split("\n")
const ROW_LABEL = "Probe render path"
const rowOf = (frame: string, label: string) => lines(frame).findIndex((line) => line.includes(label))

test("the session view lists level-1 subagents in an agents block", async () => {
  await withSession(async (setup) => {
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Agents")
    expect(frame).toContain("1/1 active")
    expect(frame).toContain(ROW_LABEL)
    expect(frame).toContain("@Explore")
    expect(frame).toContain("running")
  })
}, 30000)

test("the agents block collapses and expands from its header", async () => {
  await withSession(async (setup) => {
    const row = rowOf(setup.captureCharFrame(), "1/1 active")
    expect(row).toBeGreaterThan(0)

    await setup.mockMouse.click(6, row)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const collapsed = setup.captureCharFrame()
    expect(collapsed).toContain("expand")
    expect(collapsed).not.toContain(ROW_LABEL)

    // The collapsed block is one line shorter, so the header moves with the layout.
    const moved = rowOf(setup.captureCharFrame(), "expand")
    await setup.mockMouse.click(6, moved)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const expanded = setup.captureCharFrame()
    expect(expanded).toContain("collapse")
    expect(expanded).toContain(ROW_LABEL)
  })
}, 30000)

test("a row re-derives in place when the subagent finishes", async () => {
  await withSession(async (setup, events) => {
    expect(setup.captureCharFrame()).toContain("running")

    events.emit({
      id: "evt_success",
      created: 400,
      type: "session.tool.success",
      durable: { aggregateID: parent.id, seq: 1, version: 2 },
      location: { directory },
      data: {
        sessionID: parent.id,
        assistantMessageID: ASSISTANT_ID,
        id: SUBAGENT_PART_ID,
        content: [{ type: "text", text: "delegated" }],
        executed: true,
      },
    })

    await setup.waitForFrame((frame) => frame.includes("✓ done"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain(ROW_LABEL)
    expect(frame).toContain("✓ done")
    expect(frame).toContain("0/1 active")
  })
}, 30000)
