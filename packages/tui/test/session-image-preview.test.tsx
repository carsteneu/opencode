/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { ImageRenderable, OptimizedBuffer, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { PromptFileAttachment, SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { sizedImage } from "./fixture/sized-image"

// The headless renderer cannot rasterize a native image frame: the block-protocol draw
// fails the native render and no frame is ever committed. These tests assert transcript
// layout, which the raster does not influence, so the draw primitive is stubbed for the file.
let rasterize: typeof OptimizedBuffer.prototype.drawImage
beforeAll(() => {
  rasterize = OptimizedBuffer.prototype.drawImage
  OptimizedBuffer.prototype.drawImage = () => false
})
afterAll(() => {
  OptimizedBuffer.prototype.drawImage = rasterize
})

const TERMINAL_WIDTH = 112
// The session frame takes 4 columns off the terminal before the transcript row starts.
const TRANSCRIPT_WIDTH = TERMINAL_WIDTH - 4

const session = {
  id: "ses_images",
  title: "Images",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function attachment(dataUri: string, name: string): PromptFileAttachment {
  return {
    data: dataUri.slice(dataUri.indexOf(",") + 1),
    mime: "image/png",
    source: { type: "inline" },
    name,
    mention: { start: 0, end: 0, text: `[Image ${name}]` },
  }
}

function userMessage(files: PromptFileAttachment[]): SessionMessageInfo {
  return { type: "user", id: "user-0", text: "Look at this", time: { created: 0 }, files }
}

function toolMessage(uris: string[]): SessionMessageInfo {
  return {
    type: "assistant",
    id: "assistant-0",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 1, completed: 2 },
    content: uris.map((uri, index) => ({
      type: "tool",
      id: `tool-${index}`,
      name: "read",
      time: { created: 2 },
      state: {
        status: "completed",
        input: { filePath: "shot.png" },
        metadata: {},
        content: [{ type: "file", uri, mime: "image/png", name: "shot.png" }],
      },
    })),
  } as unknown as SessionMessageInfo
}

async function renderSession(
  statePath: string,
  messages: SessionMessageInfo[],
  options: { imagePreview?: boolean; running?: boolean; width?: number; height?: number } = {},
) {
  const setup = await createTestRenderer({
    width: options.width ?? TERMINAL_WIDTH,
    height: options.height ?? 34,
    useThread: false,
    kittyKeyboard: true,
  })
  // oxlint-disable-next-line no-restricted-globals -- OpenTUI does not expose test resolution mutation publicly.
  Reflect.set(setup.renderer, "_resolution", { width: 800, height: 720 })
  setup.renderer.start()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: options.running ? { [session.id]: {} } : {} })
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
        get: async () => ({
          animations: false,
          tabs: { enabled: false },
          session: { image_preview: options.imagePreview ?? true },
        }),
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

function collectImages(node: Renderable, found: ImageRenderable[] = []): ImageRenderable[] {
  if (node instanceof ImageRenderable) found.push(node)
  for (const child of node.getChildren()) collectImages(child, found)
  return found
}

test("stretches a user attachment across the transcript row", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, [userMessage([attachment(sizedImage(96, 48), "sun.png")])])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const images = collectImages(setup.renderer.root)
    expect(images).toHaveLength(1)
    // A 112-column terminal leaves a 108-column transcript row; the message reserves one border
    // column and the preview row 2 + 2 of padding, so a single preview spans all 103 that are left.
    expect(images[0]!.width).toBe(103)
    expect(images[0]!.width / TRANSCRIPT_WIDTH).toBeGreaterThan(0.95)
    // 96 x 48 at the fixture's 2.96:1 cell aspect needs one row per 5.93 columns.
    expect(images[0]!.height).toBe(17)
    expect(setup.captureCharFrame()).toContain("Look at this")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("gives every attachment its own full-width line", async () => {
  await using state = await tmpdir()
  const files = [
    attachment(sizedImage(96, 48), "one.png"),
    attachment(sizedImage(48, 48), "two.png"),
    attachment(sizedImage(192, 48), "three.png"),
    attachment(sizedImage(96, 96), "four.png"),
  ]
  const { setup, server, task } = await renderSession(state.path, [userMessage(files)])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const images = collectImages(setup.renderer.root)
    // No preview is capped or counted down: all four attachments are on screen, each on its own
    // line at the full 103 columns.
    expect(images).toHaveLength(4)
    expect(images.map((image) => image.width)).toEqual([103, 103, 103, 103])
    // Each box follows its own aspect ratio at that width.
    expect(images.map((image) => image.height)).toEqual([17, 35, 9, 35])
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("stacks two previews at full width", async () => {
  await using state = await tmpdir()
  const files = [attachment(sizedImage(96, 48), "one.png"), attachment(sizedImage(48, 48), "two.png")]
  const { setup, server, task } = await renderSession(state.path, [userMessage(files)])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const images = collectImages(setup.renderer.root)
    expect(images.map((image) => image.width)).toEqual([103, 103])
    expect(images.map((image) => image.height)).toEqual([17, 35])
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("resizes a preview in place instead of re-creating it", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, [userMessage([attachment(sizedImage(96, 48), "sun.png")])])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const before = collectImages(setup.renderer.root)[0]!
    setup.resize(90, 30)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const after = collectImages(setup.renderer.root)[0]!
    // The same renderable keeps its decoded image; a re-created one would decode the source again.
    expect(after).toBe(before)
    expect(after.width).toBe(81)
    // A resize drops the renderer's pixel resolution until the terminal answers the query again,
    // so the fallback ratio of 2 applies: 81 columns over 2 x 2 is 20 rows.
    expect(after.height).toBe(20)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("keeps every preview in a terminal too narrow for a wide one", async () => {
  await using state = await tmpdir()
  const files = [
    attachment(sizedImage(96, 48), "one.png"),
    attachment(sizedImage(48, 48), "two.png"),
    attachment(sizedImage(192, 48), "three.png"),
    attachment(sizedImage(96, 96), "four.png"),
  ]
  const { setup, server, task } = await renderSession(state.path, [userMessage(files)], { width: 24, height: 34 })
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const images = collectImages(setup.renderer.root)
    // A 20-column transcript row leaves 15 columns per preview; the boxes follow it down.
    expect(images).toHaveLength(4)
    // Below 44 terminal columns the session frame reserves two columns fewer than ctx.width
    // assumes, so the box lands two columns wider than the height basis; the floor absorbs it.
    expect(images.map((image) => image.width)).toEqual([17, 17, 17, 17])
    // The fixture keeps its 800 x 720 resolution while the terminal narrows, so its cells are far
    // wider than tall here (0.64:1) and the heights follow that ratio instead of 2.96:1.
    expect(images.map((image) => image.height)).toEqual([12, 24, 6, 24])
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("stretches a tool result image across the transcript row", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, [toolMessage([sizedImage(96, 48)])])
  try {
    await setup.waitForVisualIdle({ quietFrames: 5 })
    const images = collectImages(setup.renderer.root)
    expect(images).toHaveLength(1)
    expect(images[0]!.width).toBe(103)
    expect(images[0]!.height).toBe(17)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("keeps No preview for an inline image above the pixel budget", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, [
    userMessage([attachment(sizedImage(3000, 3000), "huge.png")]),
  ])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("keeps No preview when the image itself fails to decode", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(state.path, [
    userMessage([attachment("data:image/png;base64,AQID", "broken.png")]),
  ])
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("draws no preview at all while the session is streaming", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(
    state.path,
    [userMessage([attachment(sizedImage(96, 48), "sun.png")])],
    { running: true },
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).not.toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("draws no preview when the session preview toggle is off", async () => {
  await using state = await tmpdir()
  const { setup, server, task } = await renderSession(
    state.path,
    [userMessage([attachment(sizedImage(96, 48), "sun.png")])],
    { imagePreview: false },
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Look at this"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).not.toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)
