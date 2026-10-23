import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { SESSION_REPLAY_WIDTH, SESSION_SIDEBAR_WIDTH } from "../src/ui/layout"

test("the replay pane is off by default and reserves its column between transcript and sidebar", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  const width = node(setup, "session-pane").width

  expect(found(setup, "session-replay")).toBeUndefined()

  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)
  expect(node(setup, "session-pane").width).toBe(width - SESSION_REPLAY_WIDTH)
  expect(text(setup, "replay-step-1")).toContain("1/2")
  expect(text(setup, "replay-step-1")).toContain("a.ts")

  // The pane sits beside the sidebar instead of replacing it.
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("b")
  await setup.waitFor(() => node(setup, "session-pane").width === width - SESSION_REPLAY_WIDTH - SESSION_SIDEBAR_WIDTH)
  await setup.flush()
  expect(found(setup, "session-replay")).toBeDefined()

  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.waitFor(() => !setup.renderer.root.findDescendantById("session-replay"))
  await setup.flush()
  expect(node(setup, "session-pane").width).toBe(width - SESSION_SIDEBAR_WIDTH)
})

test("a narrow terminal refuses the toggle, keeps the state and says why", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 120 })
  await ready(setup)

  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Terminal too narrow for replay pane"))
  expect(found(setup, "session-replay")).toBeUndefined()

  // The refusal must not have flipped the stored preference.
  setup.resize(200, 36)
  await setup.flush()
  expect(found(setup, "session-replay")).toBeUndefined()

  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_WIDTH)
})

test("widening after an open pane keeps it, narrowing hides it until the terminal is wide again", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  setup.resize(110, 36)
  await setup.waitFor(() => !setup.renderer.root.findDescendantById("session-replay"))
  setup.resize(200, 36)
  await replayReady(setup)

  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.waitFor(() => !setup.renderer.root.findDescendantById("session-replay"))
})

const session = {
  id: `ses_replay_${crypto.randomUUID()}`,
  title: "Replay fixture",
  projectID: "proj_replay",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 12 },
} satisfies SessionInfo

function messages(): SessionMessageInfo[] {
  return [
    { id: "msg_replay_01", type: "user", text: "Transcript item 1", time: { created: 1 } },
    {
      id: "msg_replay_02",
      type: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "model" },
      time: { created: 2 },
      content: [
        { type: "text", text: "Transcript item 2" },
        {
          type: "tool",
          id: "prt_replay_01",
          name: "edit",
          time: { created: 3 },
          state: {
            status: "completed",
            input: { path: "src/a.ts" },
            content: [{ type: "text", text: "ok" }],
            metadata: { files: [{ file: "src/a.ts", patch: "@@ -1,3 +1,3 @@\n a\n-b\n+c\n" }] },
          },
        },
        {
          type: "tool",
          id: "prt_replay_02",
          name: "write",
          time: { created: 4 },
          state: {
            status: "completed",
            input: { path: "src/b.ts", content: "export const b = 1" },
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
    } as unknown as SessionMessageInfo,
    { id: "msg_replay_03", type: "user", text: "Transcript item 3", time: { created: 5 } },
  ]
}

async function createSessionFixture(state: string, input: { width: number }) {
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  return createAppFixture({
    width: input.width,
    height: 36,
    state,
    args: { sessionID: session.id },
    config: {
      animations: false,
      tabs: { enabled: false },
      session: { sidebar: "hide" },
    },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs") return json({ location, data: { branch: { current: "replay", default: "v2" } } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages().toReversed(), cursor: {} })
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
  await setup.waitForFrame((frame) => frame.includes("Transcript item 3") && frame.includes("Build · Model"), {
    maxPasses: 120,
  })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
}

async function replayReady(setup: AppFixture) {
  await setup.waitForFrame((frame) => frame.includes("Replay") && frame.includes("1/2 edit"), { maxPasses: 120 })
  await setup.flush()
}

function node(setup: AppFixture, id: string) {
  const result = setup.renderer.root.findDescendantById(id)
  if (!result) throw new Error(`Missing renderable: ${id}\n${setup.captureCharFrame()}`)
  return result
}

function found(setup: AppFixture, id: string) {
  return setup.renderer.root.findDescendantById(id)
}

function text(setup: AppFixture, id: string) {
  const item: Renderable | undefined = setup.renderer.root.findDescendantById(id)
  if (!item) return ""
  return setup
    .captureCharFrame()
    .split("\n")
    .slice(item.y, item.y + item.height)
    .map((line) => line.slice(item.x, item.x + item.width).trim())
    .join("\n")
    .trim()
}
