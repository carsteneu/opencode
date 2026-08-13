import { describe, expect, test } from "bun:test"
import { loadSessionImageSource } from "../../src/util/session-image-load"
import { SESSION_IMAGE_SOURCE_MAX_CONCURRENCY, SessionImageSourceStore } from "../../src/util/session-image-source"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const other =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

describe("session image source store", () => {
  test("rejects concurrency above the hard loader limit", () => {
    expect(() => new SessionImageSourceStore({ maxConcurrency: 3 })).toThrow("Invalid image source concurrency")
  })

  test("coalesces concurrent loads and returns bytes with image metadata", async () => {
    let calls = 0
    const store = new SessionImageSourceStore({
      loader: (value, signal) => {
        calls++
        return loadSessionImageSource(value, signal)
      },
    })

    const [first, second] = await Promise.all([store.load(pixel), store.load(pixel)])
    const remounted = await store.load(pixel)

    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(remounted).toBe(first)
    expect(first.width).toBe(1)
    expect(first.height).toBe(1)
    expect(first.data).toBeInstanceOf(Uint8Array)
    expect(store.peek(pixel)).toBe(first)
    expect(store.size).toBe(1)
    expect(store.totalBytes).toBe(first.data.byteLength)
    store.dispose()
  })

  test("copies Buffer-backed input into an exact plain Uint8Array", async () => {
    const input = Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64")
    const store = new SessionImageSourceStore({ loader: async () => input })
    const source = await store.load("buffer")

    expect(source.data).not.toBe(input)
    expect(Buffer.isBuffer(source.data)).toBeFalse()
    expect(source.data.byteOffset).toBe(0)
    expect(source.data.buffer.byteLength).toBe(source.data.byteLength)
    expect(source.data).toEqual(new Uint8Array(input))
    store.dispose()
  })

  test("starts at most two loaders and advances its queue as work settles", async () => {
    const releases: Array<() => void> = []
    const started: string[] = []
    let running = 0
    let maximum = 0
    const store = new SessionImageSourceStore({
      loader: async (value) => {
        started.push(value)
        running++
        maximum = Math.max(maximum, running)
        await new Promise<void>((resolve) => releases.push(resolve))
        running--
        return imageBytes()
      },
    })

    const first = store.load("first")
    const second = store.load("second")
    const third = store.load("third")
    await waitFor(() => started.length === SESSION_IMAGE_SOURCE_MAX_CONCURRENCY)

    expect(started).toEqual(["first", "second"])
    expect(store.activeLoads).toBe(2)
    expect(store.queuedLoads).toBe(1)
    expect(maximum).toBe(2)

    releases.shift()?.()
    await waitFor(() => started.length === 3)
    expect(started).toEqual(["first", "second", "third"])
    expect(maximum).toBe(2)

    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second, third])
    expect(store.activeLoads).toBe(0)
    store.dispose()
  })

  test("drops an aborted queued consumer without starting its loader", async () => {
    let release: () => void = () => undefined
    const started: string[] = []
    const store = new SessionImageSourceStore({
      maxConcurrency: 1,
      loader: async (value) => {
        started.push(value)
        if (value === "first") await new Promise<void>((resolve) => (release = resolve))
        return imageBytes()
      },
    })
    const first = store.load("first")
    const controller = new AbortController()
    const queued = store.load("queued", controller.signal)
    await waitFor(() => started.length === 1 && store.queuedLoads === 1)
    controller.abort(new Error("left viewport"))

    expect(
      await queued.then(
        () => undefined,
        (error) => error,
      ),
    ).toBeInstanceOf(Error)
    expect(started).toEqual(["first"])
    expect(store.queuedLoads).toBe(0)
    release()
    await first
    store.dispose()
  })

  test("aborts shared loader work only after its last consumer leaves", async () => {
    let loaderSignal: AbortSignal | undefined
    const store = new SessionImageSourceStore({
      loader: (_value, signal) => {
        loaderSignal = signal
        return new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = store.load("shared", firstController.signal)
    const second = store.load("shared", secondController.signal)
    await waitFor(() => loaderSignal !== undefined)

    firstController.abort(new Error("first left"))
    expect(
      await first.then(
        () => undefined,
        (error) => error,
      ),
    ).toBeInstanceOf(Error)
    expect(loaderSignal?.aborted).toBeFalse()

    secondController.abort(new Error("second left"))
    expect(
      await second.then(
        () => undefined,
        (error) => error,
      ),
    ).toBeInstanceOf(Error)
    await waitFor(() => loaderSignal?.aborted === true)
    expect(loaderSignal?.aborted).toBeTrue()
    await waitFor(() => store.activeLoads === 0)
    store.dispose()
  })

  test("pins an acquired source against LRU eviction until idempotent release", async () => {
    let calls = 0
    const store = new SessionImageSourceStore({
      maxBytes: 1024,
      maxEntries: 1,
      loader: (value, signal) => {
        calls++
        return loadSessionImageSource(value === "first" ? pixel : other, signal)
      },
    })
    const lease = await store.acquire("first")
    const prefetched = await store.load("second")

    expect(prefetched.data).toBeInstanceOf(Uint8Array)
    expect(store.peek("first")).toBe(lease.source)
    expect(store.peek("second")).toBeUndefined()
    expect(store.size).toBe(1)

    lease.release()
    lease.release()
    expect((await store.load("second")).data).toBeInstanceOf(Uint8Array)
    expect(store.peek("first")).toBeUndefined()
    expect(store.peek("second")).toBeDefined()
    expect(calls).toBe(3)
    store.dispose()
  })

  test("keeps disposed pinned bytes accounted until their lease releases", async () => {
    const store = new SessionImageSourceStore()
    const lease = await store.acquire(pixel)
    const bytes = lease.source.data.byteLength

    store.dispose()
    expect(store.size).toBe(0)
    expect(store.totalBytes).toBe(bytes)
    expect(
      await store.load(pixel).then(
        () => undefined,
        (error) => error,
      ),
    ).toBeInstanceOf(Error)

    lease.release()
    expect(store.totalBytes).toBe(0)
  })

  test("dispose rejects running consumers even when a loader delays abort handling", async () => {
    let release: () => void = () => undefined
    const store = new SessionImageSourceStore({
      loader: async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return imageBytes()
      },
    })
    const pending = store.load("running")
    await waitFor(() => store.activeLoads === 1)

    store.dispose()
    expect(
      await pending.then(
        () => undefined,
        (error) => error,
      ),
    ).toHaveProperty("message", "Image source store is disposed")

    release()
    await waitFor(() => store.activeLoads === 0)
    expect(store.totalBytes).toBe(0)
  })

  test("retries cleanly after a rejected loader", async () => {
    let calls = 0
    const store = new SessionImageSourceStore({
      loader: async () => {
        calls++
        if (calls === 1) throw new Error("temporary failure")
        return imageBytes()
      },
    })

    const error = await store.load("retry").then(
      () => undefined,
      (reason) => reason,
    )
    expect(error).toHaveProperty("message", "temporary failure")
    expect((await store.load("retry")).data).toBeInstanceOf(Uint8Array)
    expect(calls).toBe(2)
    store.dispose()
  })

  test("enforces a caller pixel limit on cached metadata", async () => {
    let calls = 0
    const store = new SessionImageSourceStore({
      loader: (value, signal) => {
        calls++
        return loadSessionImageSource(value, signal)
      },
    })

    expect((await store.load(pixel, undefined, 1)).data).toBeInstanceOf(Uint8Array)
    const error = await store.load(pixel, undefined, 0).then(
      () => undefined,
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty("message", "Image is too large for an inline preview")
    expect(calls).toBe(1)
    store.dispose()
  })
})

function imageBytes() {
  return Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64")
}

async function waitFor(condition: () => boolean) {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for image source state")
}
