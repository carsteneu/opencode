/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { OptimizedBuffer } from "@opentui/core"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/fixture"
import {
  attachment,
  collectImages,
  imageFile,
  markdownBody,
  renderSession,
  sizedImage,
  textMessage,
  toolMessage,
  TRANSCRIPT_WIDTH,
  userMessage,
} from "./fixture/session-images"

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

// A markdown image lives in the text of a part, and is either a local file, a remote reference, or an
// inline data URL. The harness writes real files, because the loader reads the bytes rather than the
// name: only an image that really is one becomes a preview.
test("gives a markdown image its own full-width line", async () => {
  await using state = await tmpdir()
  const target = await imageFile(state.path, "chart.png", 96, 48)
  const messages = [textMessage(markdownBody(target))]
  const requests: { method: string; url: string }[] = []
  const { setup, server, task } = await renderSession(state.path, messages, {
    directory: state.path,
    onRequest: (url, request) => requests.push({ method: request.method, url: url.href }),
  })
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const images = collectImages(setup.renderer.root)
    expect(images).toHaveLength(1)
    // The transcript row is 108 columns wide; the preview box takes 3 + 2 of padding, so the glyph
    // spans the 103 that are left - the same full-width row an attachment already gets.
    expect(images[0]!.width).toBe(103)
    // 96 x 48 at the fixture's 2.96:1 cell aspect needs one row per 5.93 columns.
    expect(images[0]!.height).toBe(17)
    expect(setup.captureCharFrame()).toContain("Shot:")
    // The preview is display only. The fixture hands the app a JSON copy of the messages, so comparing
    // those objects would prove nothing; what can fail is the outgoing side: no request may carry the
    // payload or the path, and nothing may leave as anything but a read, which is the only shape a
    // leaked preview could take.
    expect(requests.filter((entry) => entry.url.includes("data:image") || entry.url.includes(target))).toEqual([])
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([])
    // And the resolved payload must not surface in the transcript text either.
    expect(setup.captureCharFrame()).not.toContain("data:image")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("opens the image dialog from a markdown preview", async () => {
  await using state = await tmpdir()
  const target = await imageFile(state.path, "chart.png", 96, 48)
  const { setup, server, task } = await renderSession(
    state.path,
    [textMessage(markdownBody(target, "quarterly chart"))],
    {
      directory: state.path,
    },
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const preview = collectImages(setup.renderer.root)[0]!
    await setup.mockMouse.click(
      preview.screenX + Math.floor(preview.width / 2),
      preview.screenY + Math.floor(preview.height / 2),
    )
    await setup.waitForFrame((frame) => frame.includes("Image 1 of 1"))
    // The alt text travels to the dialog as the image's label.
    expect(setup.captureCharFrame()).toContain("quarterly chart")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("resolves a relative markdown reference against the session directory", async () => {
  await using state = await tmpdir()
  await imageFile(state.path, "chart.png", 96, 48)
  const { setup, server, task } = await renderSession(state.path, [textMessage("Shot:\n\n![chart](chart.png)\n")], {
    directory: state.path,
  })
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(1)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("keeps No preview for a markdown image above the pixel budget", async () => {
  await using state = await tmpdir()
  const target = await imageFile(state.path, "huge.png", 3000, 3000)
  const { setup, server, task } = await renderSession(state.path, [textMessage(markdownBody(target))], {
    directory: state.path,
  })
  try {
    // An oversized preview keeps the row it would have filled, so the notice is what the frame offers.
    await setup.waitForFrame((frame) => frame.includes("No preview"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("previews a reference whose file only appears afterwards", async () => {
  await using state = await tmpdir()
  const target = path.join(state.path, "late.png")
  const { setup, server, task } = await renderSession(state.path, [textMessage(markdownBody(target, "late"))], {
    directory: state.path,
  })
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    // The file does not exist yet, which is a failure the row must not treat as final.
    expect(collectImages(setup.renderer.root)).toHaveLength(0)

    await writeFile(target, Buffer.from(sizedImage(96, 48).split(",")[1]!, "base64"))
    for (let attempt = 0; attempt < 60 && collectImages(setup.renderer.root).length === 0; attempt++) {
      await Bun.sleep(100)
      await setup.waitForVisualIdle({ quietFrames: 1 })
    }
    expect(collectImages(setup.renderer.root)).toHaveLength(1)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 30000)

test("ignores a markdown reference that is not an image", async () => {
  await using state = await tmpdir()
  const target = path.join(state.path, "notes.png")
  await writeFile(target, "a text file that merely claims to be a png")
  const { setup, server, task } = await renderSession(state.path, [textMessage(markdownBody(target, "notes"))], {
    directory: state.path,
  })
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    // A reference that resolves to no previewable image adds no row and no placeholder: the markdown
    // itself still renders, so nothing disappears from the transcript.
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).not.toContain("No preview")
    expect(setup.captureCharFrame()).toContain("Shot:")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("draws no markdown preview while the session is streaming", async () => {
  await using state = await tmpdir()
  const target = await imageFile(state.path, "chart.png", 96, 48)
  const { setup, server, task } = await renderSession(state.path, [textMessage(markdownBody(target))], {
    directory: state.path,
    running: true,
  })
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)

test("draws no markdown preview when the session preview toggle is off", async () => {
  await using state = await tmpdir()
  const target = await imageFile(state.path, "chart.png", 96, 48)
  const { setup, server, task } = await renderSession(
    state.path,
    [textMessage(`Shot:\n\n![remote](https://cdn.example.com/chart.png)\n![local](<${target}>)\n`)],
    { directory: state.path, imagePreview: false },
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Shot:"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(collectImages(setup.renderer.root)).toHaveLength(0)
    expect(setup.captureCharFrame()).not.toContain("No preview")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)
