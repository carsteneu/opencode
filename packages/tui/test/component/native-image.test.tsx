/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { SessionNativeImage } from "../../src/component/native-image"
import { SessionStaticImage, SessionStaticImageRenderable } from "../../src/component/static-image"
import { sessionImagePreviewActive } from "../../src/util/session-image"
import type { SessionImageSnapshot } from "../../src/util/session-image-snapshot"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

test("uses the OpenTUI Dynamic reconciler to create and dispose a native image", async () => {
  let loaded: { width: number; height: number } | undefined
  const app = await testRender(
    () => (
      <SessionNativeImage
        source={pixel}
        fit="fit"
        protocol="auto"
        width={4}
        height={2}
        onLoad={(image) => {
          loaded = { width: image.width, height: image.height }
        }}
      />
    ),
    { width: 10, height: 6, useThread: false },
  )

  const image = await waitForImage(app.renderer.root)
  await image.loadPromise
  expect(image.image?.width).toBe(1)
  expect(image.image?.height).toBe(1)
  expect(loaded).toEqual({ width: 1, height: 1 })

  const decoded = image.image!
  app.renderer.destroy()
  expect(() => decoded.info()).toThrow("NativeImage is disposed")
})

test("keeps only one native session image source active", async () => {
  const app = await testRender(
    () => (
      <box>
        <SessionNativeImage source={pixel} fit="fit" protocol="auto" width={4} height={2} />
        <SessionNativeImage source={pixel} fit="fit" protocol="auto" width={4} height={2} />
      </box>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    await waitForImage(app.renderer.root)
    expect(findImages(app.renderer.root)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("unmounts a native image when a later turn becomes busy", async () => {
  const [idle, setIdle] = createSignal(true)
  let released = 0
  const app = await testRender(
    () => (
      <Show
        when={sessionImagePreviewActive({
          supported: true,
          idle: idle(),
          dialogOpen: false,
          eager: true,
          failed: false,
          demoted: false,
        })}
        fallback={<SessionStaticImage snapshot={snapshot()} />}
      >
        <SessionNativeImage
          source={pixel}
          fit="fit"
          protocol="auto"
          width={4}
          height={2}
          onRelease={() => released++}
        />
      </Show>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const image = await waitForImage(app.renderer.root)
    await image.loadPromise

    setIdle(false)
    await Bun.sleep(20)

    expect(findImages(app.renderer.root)).toHaveLength(0)
    expect(find(app.renderer.root, SessionStaticImageRenderable)).toHaveLength(1)
    expect(released).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

async function waitForImage(root: Renderable) {
  return (await waitForImages(root, 1))[0]
}

async function waitForImages(root: Renderable, count: number) {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    const images = findImages(root)
    if (images.length >= count) return images
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${count} native images`)
}

function findImages(renderable: Renderable): ImageRenderable[] {
  return [
    ...(renderable instanceof ImageRenderable ? [renderable] : []),
    ...renderable.getChildren().flatMap(findImages),
  ]
}

function snapshot(): SessionImageSnapshot {
  return {
    key: "static",
    width: 1,
    height: 1,
    pixelWidth: 2,
    pixelHeight: 2,
    pixels: new Uint8Array(16).fill(255),
  }
}

function find<T extends Renderable>(renderable: Renderable, type: abstract new (...args: never[]) => T): T[] {
  return [
    ...(renderable instanceof type ? [renderable] : []),
    ...renderable.getChildren().flatMap((child) => find(child, type)),
  ]
}
