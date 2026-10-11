import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

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

const messages: SessionMessageInfo[] = [
  { type: "user", id: "user_1", text: "delegate this", time: { created: 0 } },
  {
    type: "assistant",
    id: "assistant_1",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "tool_subagent",
        name: "subagent",
        time: { created: 2 },
        state: { status: "running", input: {}, metadata: { sessionID: child.id } },
      },
    ],
  },
] as unknown as SessionMessageInfo[]

async function withSession(run: (setup: Setup) => Promise<void>) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const calls = createFetch((url) => {
    const messagesFor = (id: string) =>
      url.pathname === `/api/session/${id}/message`
        ? json({ data: id === parent.id ? messages.toReversed() : [], cursor: {} })
        : undefined
    return (
      messagesFor(parent.id) ??
      messagesFor(child.id) ??
      (url.pathname === "/api/session"
        ? json({ data: url.searchParams.get("parentID") ? [child] : [parent, child], cursor: {} })
        : url.pathname === `/api/session/${parent.id}`
          ? json({ data: parent })
          : url.pathname === `/api/session/${child.id}`
            ? json({ data: child })
            : /^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)
              ? json({ data: [] })
              : undefined)
    )
  }, createEventStream())
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
    await run(setup)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

const lines = (frame: string) => frame.split("\n")
const rowOf = (frame: string, label: string) => lines(frame).findIndex((line) => line.includes(label))

test("the session view lists level-1 subagents in an agents block", async () => {
  await withSession(async (setup) => {
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Agents")
    expect(frame).toContain("1/1 active")
    expect(frame).toContain("Probe render path")
    expect(frame).toContain("@Explore")
    expect(frame).toContain("running")
  })
}, 20000)

test("the agents block collapses and expands from its header", async () => {
  await withSession(async (setup) => {
    const row = rowOf(setup.captureCharFrame(), "1/1 active")
    expect(row).toBeGreaterThan(0)

    await setup.mockMouse.click(6, row)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const collapsed = setup.captureCharFrame()
    expect(collapsed).toContain("expand")
    expect(collapsed).not.toContain("Probe render path")

    // The collapsed block is one line shorter, so the header moves with the layout.
    const moved = rowOf(setup.captureCharFrame(), "expand")
    await setup.mockMouse.click(6, moved)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const expanded = setup.captureCharFrame()
    expect(expanded).toContain("collapse")
    expect(expanded).toContain("Probe render path")
  })
}, 20000)
