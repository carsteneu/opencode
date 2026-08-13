/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { SessionNativeImage } from "../../src/component/native-image"
import { sessionImagePreviewActive } from "../../src/util/session-image"

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

test("keeps only one session image source active", async () => {
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

test("keeps a loaded image mounted when a later turn becomes busy", async () => {
  const [idle, setIdle] = createSignal(true)
  const [loaded, setLoaded] = createSignal(false)
  const app = await testRender(
    () => (
      <Show
        when={sessionImagePreviewActive({
          supported: true,
          idle: idle(),
          loaded: loaded(),
          dialogOpen: false,
          eager: true,
          failed: false,
        })}
      >
        <SessionNativeImage
          source={pixel}
          fit="fit"
          protocol="auto"
          width={4}
          height={2}
          onLoad={() => setLoaded(true)}
        />
      </Show>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const image = await waitForImage(app.renderer.root)
    await image.loadPromise
    expect(loaded()).toBeTrue()

    setIdle(false)
    await Bun.sleep(20)

    expect(findImages(app.renderer.root)).toEqual([image])
  } finally {
    app.renderer.destroy()
  }
})

async function waitForImage(root: Renderable) {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    const image = findImages(root)[0]
    if (image) return image
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for native image")
}

function findImages(renderable: Renderable): ImageRenderable[] {
  return [
    ...(renderable instanceof ImageRenderable ? [renderable] : []),
    ...renderable.getChildren().flatMap(findImages),
  ]
}
