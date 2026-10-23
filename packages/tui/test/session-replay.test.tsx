import { expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import type { FileDiffInfo, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import {
  SESSION_REPLAY_MIN_WIDTH,
  SESSION_REPLAY_WIDTH,
  SESSION_SIDEBAR_WIDTH,
} from "../src/ui/layout"

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
  expect(text(setup, "replay-step-1")).toContain("a0.ts")

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

test("a fullscreen panel hides the replay column instead of pushing the panel out of the frame", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("file00.txt"), { maxPasses: 120 })
  expect(found(setup, "session-replay")).toBeDefined()

  setup.mockInput.pressKey("f")
  await setup.waitFor(() => found(setup, "session-panel")?.width === setup.renderer.width)
  expect(found(setup, "session-replay")).toBeUndefined()

  setup.mockInput.pressKey("f")
  await replayReady(setup)
})

test("a long ledger opens at its newest step", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200, edits: 8 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("8/8"), { maxPasses: 120 })

  const ledger = replayScroll(setup)
  await setup.waitFor(() => ledger.scrollTop > 0)
  expect(setup.captureCharFrame()).toContain("8/8")
  expect(setup.captureCharFrame()).not.toContain("1/8")
})

test("the toggle follows the configured keybind", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, {
    width: 200,
    keybinds: { "session.replay.toggle": "f7" },
  })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.flush()
  expect(found(setup, "session-replay")).toBeUndefined()

  setup.mockInput.pressKey("F7")
  await replayReady(setup)
})

test("the toggle belongs to the session it was pressed in", async () => {
  await using state = await tmpdir()
  const other = `ses_replay_other_${crypto.randomUUID()}`
  {
    await using setup = await createSessionFixture(state.path, { width: 200 })
    await ready(setup)
    setup.mockInput.pressKey("y", { ctrl: true })
    await replayReady(setup)
    expect(await storedReplayOpen(state.path, session.id)).toBe(true)
  }

  // Another session inherits nothing from the one that was left open, and its
  // own toggle stays its own.
  {
    await using setup = await createSessionFixture(state.path, { width: 200, id: other })
    await ready(setup)
    expect(found(setup, "session-replay")).toBeUndefined()
    setup.mockInput.pressKey("y", { ctrl: true })
    await replayReady(setup)
  }

  // Both decisions come back on their own session, none on the other.
  {
    await using setup = await createSessionFixture(state.path, { width: 200 })
    await ready(setup)
    await replayReady(setup)
  }
})

test("the replay column is part of the split budget at the narrowest wide terminal", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 121 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("file00.txt"), { maxPasses: 120 })
  await setup.flush()
  const panel = node(setup, "session-panel")
  const transcript = node(setup, "session-pane").width
  // The split clamp must know the replay column; otherwise the panel keeps half
  // the terminal and the transcript drops far below its 44-column minimum.
  expect(transcript + panel.width + SESSION_REPLAY_WIDTH).toBeLessThanOrEqual(121)
  expect(transcript).toBeGreaterThanOrEqual(43)
})

test("the toggle does what its label says while a panel is fullscreen", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("file00.txt"), { maxPasses: 120 })
  setup.mockInput.pressKey("f")
  await setup.waitFor(() => found(setup, "session-panel")?.width === setup.renderer.width)
  expect(found(setup, "session-replay")).toBeUndefined()

  // Hiding the open pane must work behind a fullscreen panel.
  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.flush()
  // Showing it must refuse with a reason instead of flipping the stored state.
  setup.mockInput.pressKey("y", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Exit the fullscreen panel to show the replay pane"))

  setup.mockInput.pressKey("f")
  await setup.waitFor(() => found(setup, "session-panel")?.width !== setup.renderer.width)
  await setup.flush()
  expect(found(setup, "session-replay")).toBeUndefined()
})

test("the replay column drags at its border, clamps at the transcript minimum and persists", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  // Nothing sits to the right, so the border is the pane's own left column.
  const border = 200 - SESSION_REPLAY_WIDTH
  expect(node(setup, "session-replay").x).toBe(border)
  expect(node(setup, "session-pane").width).toBe(border)

  await setup.mockMouse.pressDown(border, 10)
  await setup.mockMouse.moveTo(border - 20, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_WIDTH + 20)
  expect(node(setup, "session-pane").width).toBe(border - 20)
  await setup.mockMouse.release(border - 20, 10)
  await setup.flush()

  // Dragging past the maximum stops where the transcript keeps its 44 columns.
  await setup.mockMouse.pressDown(border - 20, 10)
  await setup.mockMouse.moveTo(8, 10)
  await setup.mockMouse.release(8, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(200 - 44)
  expect(node(setup, "session-pane").width).toBe(44)

  expect(await storedLayout(state.path)).toMatchObject({ replayWidth: 200 - 44 })
})

test("dragging the replay border never resizes the panel split", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("file00.txt"), { maxPasses: 120 })
  await setup.flush()
  const panel = node(setup, "session-panel").width
  const border = 200 - panel - SESSION_REPLAY_WIDTH

  await setup.mockMouse.pressDown(border, 10)
  await setup.mockMouse.moveTo(border - 20, 10)
  await setup.mockMouse.release(border - 20, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_WIDTH + 20)
  expect(node(setup, "session-panel").width).toBe(panel)

  // The panel keeps its column out of the replay's budget: 100 + 56 + 44 = 200.
  await setup.mockMouse.pressDown(border - 20, 10)
  await setup.mockMouse.moveTo(8, 10)
  await setup.mockMouse.release(8, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(200 - panel - 44)
  expect(node(setup, "session-panel").width).toBe(panel)
})

test("a stored replay width is restored when the pane opens", async () => {
  await using state = await tmpdir()
  mkdirSync(path.join(state.path, "test", "tui"), { recursive: true })
  await Bun.write(path.join(state.path, "test", "tui", "layout.json"), JSON.stringify({ replayWidth: 52 }))

  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)
  expect(node(setup, "session-replay").width).toBe(52)
  expect(node(setup, "session-pane").width).toBe(148)
})

test("a stored replay width from a wider terminal never crushes the panel", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 240 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)

  // Fill the row with the replay first, so its stored width no longer fits later.
  await setup.mockMouse.pressDown(240 - SESSION_REPLAY_WIDTH, 10)
  await setup.mockMouse.moveTo(4, 10)
  await setup.mockMouse.release(4, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(240 - 44)

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("file00.txt"), { maxPasses: 120 })
  setup.resize(130, 36)
  await setup.flush()

  const replay = node(setup, "session-replay").width
  const panel = node(setup, "session-panel").width
  const transcript = node(setup, "session-pane").width
  // The stored width yields to the row, and the pane keeps the share it holds
  // without any dragged replay: 50 + 40 + 40 is what the claim of 36 allows here.
  expect(panel).toBe(50)
  expect(replay).toBe(40)
  expect(transcript).toBe(40)
  expect(transcript + replay + panel).toBeLessThanOrEqual(130)
})

test("the replay border also drags beside the sidebar and stops at its floor", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 200 })
  await ready(setup)
  setup.mockInput.pressKey("y", { ctrl: true })
  await replayReady(setup)
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("b")
  await setup.waitFor(() => node(setup, "session-pane").width === 200 - SESSION_REPLAY_WIDTH - SESSION_SIDEBAR_WIDTH)
  await setup.flush()

  // The sidebar is a fixed column, so the border sits that much further left.
  const border = 200 - SESSION_SIDEBAR_WIDTH - SESSION_REPLAY_WIDTH
  expect(node(setup, "session-replay").x).toBe(border)

  await setup.mockMouse.pressDown(border, 10)
  await setup.mockMouse.moveTo(border - 16, 10)
  await setup.mockMouse.release(border - 16, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_WIDTH + 16)
  expect(node(setup, "session-pane").width).toBe(border - 16)

  // Dragging right past the floor keeps the column usable instead of vanishing.
  const grown = border - 16
  await setup.mockMouse.pressDown(grown, 10)
  await setup.mockMouse.moveTo(150, 10)
  await setup.mockMouse.release(150, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_MIN_WIDTH)

  // Double-clicking the border restores the default column.
  await setup.mockMouse.doubleClick(200 - SESSION_SIDEBAR_WIDTH - SESSION_REPLAY_MIN_WIDTH, 10)
  await setup.flush()
  expect(node(setup, "session-replay").width).toBe(SESSION_REPLAY_WIDTH)
})

const diffs = Array.from({ length: 2 }, (_, index) => ({
  file: `src/file0${index}.txt`,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: [
    `--- a/src/file0${index}.txt`,
    `+++ b/src/file0${index}.txt`,
    "@@ -1,2 +1,2 @@",
    "-before",
    "+after",
    " context",
    "",
  ].join("\n"),
})) satisfies FileDiffInfo[]

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

function messages(edits = 2): SessionMessageInfo[] {
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
        ...Array.from({ length: edits }, (_, index) => editPart(index)),
      ],
    } as unknown as SessionMessageInfo,
    { id: "msg_replay_03", type: "user", text: "Transcript item 3", time: { created: 5 } },
  ]
}

function editPart(index: number) {
  const file = index === 1 ? "src/b.ts" : `src/a${index}.ts`
  return index % 2 === 0
    ? {
        type: "tool",
        id: `prt_replay_${index}`,
        name: "edit",
        time: { created: 3 + index },
        state: {
          status: "completed",
          input: { path: file },
          content: [{ type: "text", text: "ok" }],
          metadata: { files: [{ file, patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n" }] },
        },
      }
    : {
        type: "tool",
        id: `prt_replay_${index}`,
        name: "write",
        time: { created: 3 + index },
        state: {
          status: "completed",
          input: { path: file, content: "export const b = 1" },
          content: [{ type: "text", text: "ok" }],
        },
      }
}

async function createSessionFixture(
  state: string,
  input: { width: number; edits?: number; keybinds?: Record<string, string>; id?: string },
) {
  const id = input.id ?? session.id
  const info = { ...session, id }
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  return createAppFixture({
    width: input.width,
    height: 36,
    state,
    args: { sessionID: id },
    config: {
      animations: false,
      tabs: { enabled: false },
      session: { sidebar: "hide" },
      diffs: { tree: false, view: "unified" },
      keybinds: { "diff.open": "f6", ...input.keybinds },
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
      if (url.pathname === "/api/vcs/base")
        return json({ location, data: { name: "v2", ref: "refs/heads/v2", source: "default" } })
      if (url.pathname === "/api/vcs/diff") return json({ location, data: diffs })
      if (url.pathname === `/api/session/${id}`) return json({ data: info })
      if (url.pathname === `/api/session/${id}/message`)
        return json({ data: messages(input.edits).toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${id}/form`) return json({ data: [] })
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

function replayScroll(setup: AppFixture) {
  const result = descendants(node(setup, "session-replay")).find((item) => item instanceof ScrollBoxRenderable)
  if (!result) throw new Error("Missing replay scrollbox")
  return result
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((item) => [item, ...descendants(item)])
}

async function storedReplayOpen(state: string, sessionID: string) {
  const file = path.join(state, "test", "tui", "replay.json")
  const deadline = Date.now() + 2_000
  let raw = ""
  while (Date.now() < deadline) {
    try {
      raw = readFileSync(file, "utf8")
      const value = (JSON.parse(raw) as { open?: Record<string, boolean> }).open?.[sessionID]
      if (value !== undefined) return value
    } catch {}
    await Bun.sleep(10)
  }
  throw new Error(`replay.json never recorded ${sessionID}: ${raw}`)
}

async function storedLayout(state: string) {
  const file = path.join(state, "test", "tui", "layout.json")
  const deadline = Date.now() + 2_000
  let raw = ""
  while (Date.now() < deadline) {
    try {
      raw = readFileSync(file, "utf8")
      const layout = JSON.parse(raw) as { replayWidth?: number }
      if (layout.replayWidth !== undefined) return layout
    } catch {}
    await Bun.sleep(10)
  }
  throw new Error(`layout.json never recorded a replay width: ${raw}`)
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
