import { imageInfo } from "@opentui/core"
import { loadSessionImageSource } from "./session-image-load"

export const SESSION_IMAGE_SOURCE_MAX_BYTES = 32 * 1024 * 1024
export const SESSION_IMAGE_SOURCE_MAX_ENTRIES = 8
export const SESSION_IMAGE_SOURCE_MAX_CONCURRENCY = 2

export type SessionImageSource = Readonly<{
  data: Uint8Array
  width: number
  height: number
}>

export type SessionImageSourceLease = Readonly<{
  source: SessionImageSource
  release: () => void
}>

export type SessionImageSourceLoader = (value: string, signal?: AbortSignal) => Promise<Uint8Array>

export type SessionImageSourceReader = (
  value: string,
  signal?: AbortSignal,
  maxPixels?: number,
) => Promise<SessionImageSource>

export type SessionImageSourceAcquirer = (
  value: string,
  signal?: AbortSignal,
  maxPixels?: number,
) => Promise<SessionImageSourceLease>

type Entry = {
  source: SessionImageSource
  pins: number
  retired: boolean
}

type Pending = {
  value: string
  controller: AbortController
  consumers: number
  state: "queued" | "running" | "settled"
  promise: Promise<SessionImageSource>
  resolve: (source: SessionImageSource) => void
  reject: (error: unknown) => void
}

export class SessionImageSourceStore {
  private sources = new Map<string, Entry>()
  private retired = new Set<Entry>()
  private pending = new Map<string, Pending>()
  private queue: Pending[] = []
  private bytes = 0
  private running = 0
  private disposed = false

  constructor(
    private readonly input: {
      maxBytes?: number
      maxEntries?: number
      maxConcurrency?: number
      loader?: SessionImageSourceLoader
    } = {},
  ) {
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid image source byte budget")
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Invalid image source entry budget")
    }
    if (
      !Number.isSafeInteger(this.maxConcurrency) ||
      this.maxConcurrency < 1 ||
      this.maxConcurrency > SESSION_IMAGE_SOURCE_MAX_CONCURRENCY
    ) {
      throw new Error("Invalid image source concurrency")
    }
  }

  public get size() {
    return this.sources.size
  }

  public get totalBytes() {
    return this.bytes
  }

  public get activeLoads() {
    return this.running
  }

  public get queuedLoads() {
    return this.queue.length
  }

  /** Returns a non-pinning source. Callers must use acquire() while a native renderable retains its bytes. */
  public load(value: string, signal?: AbortSignal, maxPixels?: number) {
    return this.request(value, signal, maxPixels)
  }

  public async acquire(value: string, signal?: AbortSignal, maxPixels?: number): Promise<SessionImageSourceLease> {
    const source = await this.request(value, signal, maxPixels)
    signal?.throwIfAborted()
    if (this.disposed) throw new Error("Image source store is disposed")

    const cached = this.sources.get(value)
    const entry = cached?.source === source ? cached : this.put(value, source)
    if (!entry) throw new Error("Image source cache budget is exhausted by active sources")
    entry.pins++
    this.touch(value, entry)

    let released = false
    return {
      source,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        if (!entry.retired || entry.pins > 0) return
        this.retired.delete(entry)
        this.bytes -= entry.source.data.byteLength
      },
    }
  }

  public peek(value: string) {
    return this.sources.get(value)?.source
  }

  public clear() {
    this.reset(new Error("Image source store cleared"))
  }

  public dispose() {
    if (this.disposed) return
    this.disposed = true
    this.reset(new Error("Image source store is disposed"))
  }

  private reset(error: Error) {
    this.cancelPending(error)
    this.sources.forEach((entry) => {
      if (entry.pins === 0) {
        this.bytes -= entry.source.data.byteLength
        return
      }
      entry.retired = true
      this.retired.add(entry)
    })
    this.sources.clear()
  }

  private get maxBytes() {
    return this.input.maxBytes ?? SESSION_IMAGE_SOURCE_MAX_BYTES
  }

  private get maxEntries() {
    return this.input.maxEntries ?? SESSION_IMAGE_SOURCE_MAX_ENTRIES
  }

  private get maxConcurrency() {
    return this.input.maxConcurrency ?? SESSION_IMAGE_SOURCE_MAX_CONCURRENCY
  }

  private async request(value: string, signal?: AbortSignal, maxPixels?: number) {
    if (this.disposed) throw new Error("Image source store is disposed")
    signal?.throwIfAborted()

    const cached = this.sources.get(value)
    if (cached) {
      this.touch(value, cached)
      validatePixels(cached.source, maxPixels)
      return cached.source
    }

    const pending = this.pending.get(value) ?? this.enqueue(value)
    pending.consumers++
    return this.wait(pending, signal)
      .then((source) => {
        validatePixels(source, maxPixels)
        return source
      })
      .finally(() => this.releaseConsumer(pending))
  }

  private enqueue(value: string) {
    let resolve: Pending["resolve"] = () => undefined
    let reject: Pending["reject"] = () => undefined
    const promise = new Promise<SessionImageSource>((success, failure) => {
      resolve = success
      reject = failure
    })
    const pending: Pending = {
      value,
      controller: new AbortController(),
      consumers: 0,
      state: "queued",
      promise,
      resolve,
      reject,
    }
    this.pending.set(value, pending)
    this.queue.push(pending)
    void promise.catch(() => undefined)
    this.pump()
    return pending
  }

  private pump() {
    if (this.disposed) return
    while (this.running < this.maxConcurrency) {
      const pending = this.queue.shift()
      if (!pending) return
      if (pending.state !== "queued" || this.pending.get(pending.value) !== pending) continue
      this.start(pending)
    }
  }

  private start(pending: Pending) {
    pending.state = "running"
    this.running++
    void Promise.resolve()
      .then(() => (this.input.loader ?? loadSessionImageSource)(pending.value, pending.controller.signal))
      .then((data) => {
        pending.controller.signal.throwIfAborted()
        if (this.disposed) throw new Error("Image source store is disposed")
        const bytes = exactBytes(data)
        const info = imageInfo(bytes)
        const source = { data: bytes, width: info.width, height: info.height }
        this.put(pending.value, source)
        pending.resolve(source)
      })
      .catch((error) => pending.reject(error))
      .finally(() => {
        pending.state = "settled"
        this.running--
        if (this.pending.get(pending.value) === pending) this.pending.delete(pending.value)
        this.pump()
      })
  }

  private wait(pending: Pending, signal?: AbortSignal) {
    if (!signal) return pending.promise
    return new Promise<SessionImageSource>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort)
        reject(signal.reason ?? new Error("Image source load aborted"))
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      pending.promise.then(
        (source) => {
          signal.removeEventListener("abort", abort)
          resolve(source)
        },
        (error) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
      )
    })
  }

  private releaseConsumer(pending: Pending) {
    pending.consumers--
    if (pending.consumers > 0 || pending.state === "settled") return
    if (this.pending.get(pending.value) === pending) this.pending.delete(pending.value)
    if (pending.state === "queued") {
      pending.state = "settled"
      this.queue = this.queue.filter((item) => item !== pending)
      pending.reject(new Error("Image source has no consumers"))
      this.pump()
      return
    }
    pending.controller.abort(new Error("Image source has no consumers"))
  }

  private cancelPending(error: Error) {
    this.pending.forEach((pending) => {
      if (pending.state === "queued") {
        pending.state = "settled"
        pending.reject(error)
        return
      }
      if (pending.state === "running") {
        pending.reject(error)
        pending.controller.abort(error)
      }
    })
    this.pending.clear()
    this.queue = []
  }

  private touch(value: string, entry: Entry) {
    if (this.sources.get(value) !== entry) return
    this.sources.delete(value)
    this.sources.set(value, entry)
  }

  private put(value: string, source: SessionImageSource) {
    const cached = this.sources.get(value)
    if (cached?.source === source) return cached
    if (source.data.byteLength > this.maxBytes) return undefined
    if (cached) {
      if (cached.pins > 0) return undefined
      this.sources.delete(value)
      this.bytes -= cached.source.data.byteLength
    }

    while (
      this.sources.size + this.retired.size >= this.maxEntries ||
      this.bytes + source.data.byteLength > this.maxBytes
    ) {
      const oldest = [...this.sources].find(([, entry]) => entry.pins === 0)
      if (!oldest) return undefined
      this.sources.delete(oldest[0])
      this.bytes -= oldest[1].source.data.byteLength
    }

    const entry = { source, pins: 0, retired: false }
    this.sources.set(value, entry)
    this.bytes += source.data.byteLength
    return entry
  }
}

function exactBytes(data: Uint8Array) {
  const result = new Uint8Array(data.byteLength)
  result.set(data)
  return result
}

function validatePixels(source: Pick<SessionImageSource, "width" | "height">, maxPixels?: number) {
  if (maxPixels === undefined) return
  if (
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    source.width <= 0 ||
    source.height <= 0 ||
    source.width > Math.floor(maxPixels / source.height)
  ) {
    throw new Error("Image is too large for an inline preview")
  }
}
