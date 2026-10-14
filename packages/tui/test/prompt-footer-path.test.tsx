/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const TERMINAL_WIDTH = 112

const session = {
  id: "ses_footer",
  title: "Footer",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

async function renderSession(statePath: string, running = false) {
  const setup = await createTestRenderer({
    width: TERMINAL_WIDTH,
    height: 34,
    useThread: false,
    kittyKeyboard: true,
  })
  setup.renderer.start()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: running ? { [session.id]: {} } : {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { enabled: false } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: statePath })), Effect.provide(FileSystem.layerNoop({}))),
  )
  return { setup, server, task }
}

// The preview row of a message reserves the border column the transcript adds, so the footer
// path must not share that row with the shortcuts either: it truncates to an ellipsis mid-path
// (`/tmp/opencode/pack...ui:main`) once the status row runs out of columns.
test("renders the working directory on its own footer line", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path)
  try {
    await setup.waitForFrame((frame) => frame.includes(directory))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const rows = setup.captureCharFrame().split("\n")

    const location = rows.filter((row) => row.includes(directory))
    expect(location).toHaveLength(1)
    // The path is alone on its row: nothing but the path, and the shortcut hint that used to
    // share it now sits on the row below.
    expect(location[0]!.trim()).toStartWith(directory)
    expect(location[0]!.trim()).not.toContain(" ")

    expect(rows.some((row) => row.includes(directory) && row.includes("commands"))).toBe(false)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

// v1's footer kept the directory on screen while the spinner ran; the path used to be an
// either-or with the run status, so an active run hid it.
test("keeps the working directory visible while the session runs", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, true)
  try {
    await setup.waitForFrame((frame) => frame.includes(directory))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const rows = setup.captureCharFrame().split("\n")

    const location = rows.filter((row) => row.includes(directory))
    expect(location).toHaveLength(1)
    expect(location[0]!.trim()).toStartWith(directory)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)
