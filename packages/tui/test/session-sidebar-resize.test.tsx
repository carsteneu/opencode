import { expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { SESSION_SIDEBAR_MIN_WIDTH, SESSION_SIDEBAR_WIDTH } from "../src/ui/layout"

test("dragging the sidebar border widens the column and stores the width", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  const start = node(setup, "session-sidebar").width
  expect(start).toBe(SESSION_SIDEBAR_WIDTH)

  // The handle spans the two columns left of the sidebar's own left edge.
  const border = 200 - start - 1
  await setup.mockMouse.pressDown(border, 10)
  await setup.mockMouse.moveTo(border - 20, 10)
  await setup.mockMouse.release(border - 20, 10)
  await setup.flush()

  expect(node(setup, "session-sidebar").width).toBe(start + 20)
  expect(await storedSidebarWidth(state.path)).toBe(start + 20)
})

test("the sidebar border stops at its floor instead of collapsing the transcript", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  const border = 200 - SESSION_SIDEBAR_WIDTH - 1

  await setup.mockMouse.pressDown(border, 10)
  await setup.mockMouse.moveTo(190, 10)
  await setup.mockMouse.release(190, 10)
  await setup.flush()

  expect(node(setup, "session-sidebar").width).toBe(SESSION_SIDEBAR_MIN_WIDTH)
})

test("a stored sidebar width is restored on the next start", async () => {
  await using state = await tmpdir()
  mkdirSync(path.join(state.path, "test", "tui"), { recursive: true })
  await Bun.write(path.join(state.path, "test", "tui", "layout.json"), JSON.stringify({ sidebarWidth: 58 }))

  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  expect(node(setup, "session-sidebar").width).toBe(58)
})

const session = {
  id: `ses_sidebar_${crypto.randomUUID()}`,
  title: "Sidebar resize fixture",
  projectID: "proj_sidebar",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 12 },
} satisfies SessionInfo

async function createSessionFixture(state: string, input: { width: number }) {
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  return createAppFixture({
    width: input.width,
    height: 36,
    state,
    args: { sessionID: session.id },
    // `auto` keeps the sidebar docked above the wide breakpoint, which is what this test drags.
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "auto" } },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs") return json({ location, data: { branch: { current: "sidebar", default: "v2" } } })
      if (url.pathname === "/api/vcs/base")
        return json({ location, data: { name: "v2", ref: "refs/heads/v2", source: "default" } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [{ id: "msg_sidebar_01", type: "user", text: "Transcript item", time: { created: 1 } }],
          cursor: {},
        })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/form`) return json({ data: [] })
      return undefined
    },
  })
}

type AppFixture = Awaited<ReturnType<typeof createAppFixture>>

async function ready(setup: AppFixture) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Transcript item") && frame.includes("Build"), {
    maxPasses: 120,
  })
  await setup.waitFor(() => setup.renderer.root.findDescendantById("session-sidebar") !== undefined)
}

function node(setup: AppFixture, id: string) {
  const result = setup.renderer.root.findDescendantById(id)
  if (!result) throw new Error(`Missing renderable: ${id}\n${setup.captureCharFrame()}`)
  return result
}

async function storedSidebarWidth(state: string) {
  const file = path.join(state, "test", "tui", "layout.json")
  const deadline = Date.now() + 2_000
  let raw = ""
  while (Date.now() < deadline) {
    try {
      raw = readFileSync(file, "utf8")
      const layout = JSON.parse(raw) as { sidebarWidth?: number }
      if (layout.sidebarWidth !== undefined) return layout.sidebarWidth
    } catch {}
    await Bun.sleep(10)
  }
  throw new Error(`layout.json never recorded a sidebar width: ${raw}`)
}
