/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SessionStaticImage, SessionStaticImageRenderable } from "../../src/component/static-image"
import type { SessionImageSnapshot } from "../../src/util/session-image-snapshot"

test("renders a retained quadrant raster without native image state and disposes its framebuffer", async () => {
  const app = await testRender(() => <SessionStaticImage snapshot={topRedBottomBlue()} />, {
    width: 4,
    height: 3,
    useThread: false,
  })
  const image = find(app.renderer.root, SessionStaticImageRenderable)[0]

  expect(image).toBeInstanceOf(SessionStaticImageRenderable)
  expect(find(app.renderer.root, ImageRenderable)).toHaveLength(0)
  expect(new TextDecoder().decode(image.frameBuffer.getRealCharBytes())).toBe("▄")

  const frameBuffer = image.frameBuffer
  app.renderer.destroy()
  expect(() => frameBuffer.getRealCharBytes()).toThrow("destroyed")
})

test("keeps earlier and later snapshots mounted without native image state", async () => {
  const first = topRedBottomBlue()
  const app = await testRender(
    () => (
      <box>
        <SessionStaticImage snapshot={first} />
        <SessionStaticImage snapshot={{ ...first, key: "later" }} />
      </box>
    ),
    { width: 4, height: 3, useThread: false },
  )

  try {
    expect(find(app.renderer.root, SessionStaticImageRenderable)).toHaveLength(2)
    expect(find(app.renderer.root, ImageRenderable)).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})

function topRedBottomBlue(): SessionImageSnapshot {
  return {
    key: "static",
    width: 1,
    height: 1,
    pixelWidth: 2,
    pixelHeight: 2,
    pixels: Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]),
  }
}

function find<T extends Renderable>(renderable: Renderable, type: abstract new (...args: never[]) => T): T[] {
  return [
    ...(renderable instanceof type ? [renderable] : []),
    ...renderable.getChildren().flatMap((child) => find(child, type)),
  ]
}
