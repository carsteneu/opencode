/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { SessionNativeImage } from "../../src/component/native-image"
import { sessionImagePreviewActive } from "../../src/util/session-image"
import { loadSessionImageSource } from "../../src/util/session-image-load"
import type { SessionImageSourceAcquirer } from "../../src/util/session-image-source"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const other =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

test("does not mount an image renderable without an active source", async () => {
  const [source, setSource] = createSignal<string>()
  const data = await loadSessionImageSource(pixel)
  let loads = 0
  let releases = 0
  let leaseReleases = 0
  const load: SessionImageSourceAcquirer = async () => ({
    source: { data, width: 1, height: 1 },
    release: () => leaseReleases++,
  })
  const app = await testRender(
    () => (
      <SessionNativeImage
        source={source()}
        load={load}
        fit="fit"
        protocol="auto"
        width={4}
        height={2}
        onLoad={() => loads++}
        onRelease={() => releases++}
      />
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    expect(findImages(app.renderer.root)).toEqual([])

    setSource(pixel)
    const renderable = await waitForLoadedImage(app.renderer.root)
    const decoded = renderable.image!
    expect(loads).toBe(1)

    setSource(undefined)
    await waitFor(() => findImages(app.renderer.root).length === 0)
    expect(findImages(app.renderer.root)).toEqual([])
    expect(releases).toBe(1)
    expect(leaseReleases).toBe(1)
    expect(() => decoded.info()).toThrow("NativeImage is disposed")

    setSource(pixel)
    const restored = await waitForLoadedImage(app.renderer.root)
    expect(restored).not.toBe(renderable)
    expect(loads).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the old native image until a replacement is ready", async () => {
  const [source, setSource] = createSignal<string | undefined>(pixel)
  const [data, replacement] = await Promise.all([loadSessionImageSource(pixel), loadSessionImageSource(other)])
  const pending = Promise.withResolvers<Awaited<ReturnType<SessionImageSourceAcquirer>>>()
  let loads = 0
  let replacementStarted = false
  let released = 0
  let replacementReleased = 0
  const load: SessionImageSourceAcquirer = async (value) => {
    if (value === other) {
      replacementStarted = true
      return pending.promise
    }
    return {
      source: { data, width: 1, height: 1 },
      release: () => released++,
    }
  }
  const app = await testRender(
    () => (
      <SessionNativeImage
        source={source()}
        load={load}
        fit="fit"
        protocol="auto"
        width={4}
        height={2}
        onLoad={() => loads++}
      />
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const renderable = await waitForLoadedImage(app.renderer.root)
    const decoded = renderable.image!
    setSource(other)
    await waitFor(() => replacementStarted)
    await Bun.sleep(50)

    expect(findImages(app.renderer.root)).toEqual([renderable])
    expect(renderable.image).toBe(decoded)
    expect(released).toBe(0)

    pending.resolve({
      source: { data: replacement, width: 1, height: 1 },
      release: () => replacementReleased++,
    })
    await waitFor(() => loads === 2)

    expect(findImages(app.renderer.root)).toEqual([renderable])
    expect(renderable.image).not.toBe(decoded)
    expect(released).toBe(1)
    expect(() => decoded.info()).toThrow("NativeImage is disposed")

    setSource(undefined)
    await waitFor(() => findImages(app.renderer.root).length === 0)
    expect(replacementReleased).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("releases the committed source lease on unmount", async () => {
  const data = await loadSessionImageSource(pixel)
  let releases = 0
  const app = await testRender(
    () => (
      <SessionNativeImage
        source={pixel}
        load={async () => ({
          source: { data, width: 1, height: 1 },
          release: () => releases++,
        })}
        fit="fit"
        protocol="auto"
        width={4}
        height={2}
      />
    ),
    { width: 10, height: 6, useThread: false },
  )

  await waitForLoadedImage(app.renderer.root)
  app.renderer.destroy()
  expect(releases).toBe(1)
})

test("allows the bounded resident set to coexist natively", async () => {
  const app = await testRender(
    () => (
      <box>
        <SessionNativeImage source={pixel} fit="fit" protocol="auto" width={4} height={2} />
        <SessionNativeImage source={other} fit="fit" protocol="auto" width={4} height={2} />
      </box>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const images = await waitForLoadedImages(app.renderer.root, 2)
    expect(images).toHaveLength(2)
    expect(images.every((image) => image.image !== null)).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})

test("preserves native object identity while the session streams", async () => {
  const [streaming, setStreaming] = createSignal(false)
  let loaded = 0
  let released = 0
  const app = await testRender(
    () => (
      <box>
        <text>{streaming() ? "streaming" : "idle"}</text>
        <SessionNativeImage
          source={
            sessionImagePreviewActive({ supported: true, dialogOpen: false, resident: true, failed: false })
              ? pixel
              : undefined
          }
          fit="fit"
          protocol="auto"
          width={4}
          height={2}
          onLoad={() => loaded++}
          onRelease={() => released++}
        />
      </box>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const renderable = await waitForLoadedImage(app.renderer.root)
    const decoded = renderable.image
    setStreaming(true)
    await Bun.sleep(100)
    setStreaming(false)
    await Bun.sleep(100)

    expect(findImages(app.renderer.root)).toEqual([renderable])
    expect(renderable.image).toBe(decoded)
    expect(loaded).toBe(1)
    expect(released).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("preserves overlapping residents and disposes only the evicted image", async () => {
  const [sources, setSources] = createSignal([pixel, other])
  const app = await testRender(
    () => (
      <box>
        <For each={sources()}>
          {(source) => <SessionNativeImage source={source} fit="fit" protocol="auto" width={4} height={2} />}
        </For>
      </box>
    ),
    { width: 10, height: 6, useThread: false },
  )

  try {
    const initial = await waitForLoadedImages(app.renderer.root, 2)
    const evicted = initial[0].image!
    const retained = initial[1]
    setSources([other])
    await waitFor(() => findImages(app.renderer.root).length === 1)

    expect(findImages(app.renderer.root)).toEqual([retained])
    expect(retained.image).not.toBeNull()
    expect(() => evicted.info()).toThrow("NativeImage is disposed")
  } finally {
    app.renderer.destroy()
  }
})

async function waitForLoadedImage(root: Renderable) {
  return (await waitForLoadedImages(root, 1))[0]
}

async function waitForLoadedImages(root: Renderable, count: number) {
  let result: ImageRenderable[] = []
  await waitFor(() => {
    result = findImages(root).filter((image) => image.image !== null)
    return result.length >= count
  })
  return result
}

async function waitFor(condition: () => boolean) {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for native image state")
}

function findImages(renderable: Renderable): ImageRenderable[] {
  return [
    ...(renderable instanceof ImageRenderable ? [renderable] : []),
    ...renderable.getChildren().flatMap(findImages),
  ]
}
