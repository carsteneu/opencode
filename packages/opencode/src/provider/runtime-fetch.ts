import { ProviderError } from "./error"

export function applyRuntimeFetch(options: Record<string, unknown>) {
  const customFetch = options["fetch"] as typeof fetch | undefined
  const chunkTimeout = typeof options["chunkTimeout"] === "number" ? options["chunkTimeout"] : undefined
  const headerTimeout = options["headerTimeout"]
  delete options["chunkTimeout"]
  delete options["headerTimeout"]

  options["fetch"] = async (input: RequestInfo | URL, init?: BunFetchRequestInit) => {
    const opts = init ?? {}
    const chunkAbortCtl = chunkTimeout !== undefined && chunkTimeout > 0 ? new AbortController() : undefined
    const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
    const signals: AbortSignal[] = []

    if (opts.signal) signals.push(opts.signal)
    if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
    if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
      signals.push(AbortSignal.timeout(options["timeout"] as number))

    const res = await (async () => {
      const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
      try {
        const allSignals = headerTimeoutCtl ? [...signals, headerTimeoutCtl.signal] : signals
        const combined =
          allSignals.length === 0 ? null : allSignals.length === 1 ? allSignals[0] : AbortSignal.any(allSignals)
        if (combined) opts.signal = combined
        return await (customFetch ?? fetch)(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      } finally {
        headerTimeoutCtl?.clear()
      }
    })()

    if (!chunkAbortCtl || chunkTimeout === undefined) return res
    return wrapBody(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

function wrapBody(
  res: Response,
  ms: number,
  ctl: AbortController,
  metadata: ResponseMetadata = { url: res.url, redirected: res.redirected, type: res.type },
  state: BodyTimeoutState = { active: 0, cancelers: new Set(), finished: false },
): Response {
  if (ms <= 0) return res
  if (res.bodyUsed) return res

  const source = res.body
  if (!source || source.locked) return res
  let raw: ReadableStream<Uint8Array<ArrayBuffer>> = source
  let reader: BodyReader | undefined
  let active = true
  const release = () => {
    if (!active) return state.active
    active = false
    state.cancelers.delete(cancelRaw)
    state.active -= 1
    return state.active
  }
  const cancelRaw = async (reason: unknown) => {
    release()
    await (reader ? reader.cancel(reason) : raw.cancel(reason))
  }
  state.active += 1
  state.cancelers.add(cancelRaw)

  const timeoutMessage = res.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ? "SSE read timed out"
    : "Provider response stream timed out"
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        if (state.error) {
          release()
          throw state.error
        }
        const current = (reader ??= raw.getReader())
        const part = await new Promise<Awaited<ReturnType<typeof current.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = state.error ?? new ProviderError.ResponseStreamError(timeoutMessage)
            state.error = err
            const cancelers = [...state.cancelers]
            ctl.abort(err)
            void Promise.allSettled(cancelers.map((cancel) => cancel(err)))
            reject(err)
          }, ms)

          current.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        }).catch((err) => {
          if (state.error) throw state.error
          release()
          throw err
        })

        if (state.error) {
          release()
          throw state.error
        }
        if (part.done) {
          if (active) state.finished = true
          release()
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        const remaining = release()
        if (remaining === 0 && !state.finished) ctl.abort(reason)
        await (reader ? reader.cancel(reason) : raw.cancel(reason))
      },
    },
    { highWaterMark: 0 },
  )

  const response = new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
  return responseMetadata(response, metadata, () => {
    if (response.bodyUsed || response.body?.locked) throw new TypeError("Response.clone: Body has already been used")
    const [left, right] = raw.tee()
    raw = left
    return wrapBody(
      new Response(right, {
        headers: new Headers(response.headers),
        status: response.status,
        statusText: response.statusText,
      }),
      ms,
      ctl,
      metadata,
      state,
    )
  })
}

type ResponseMetadata = Pick<Response, "url" | "redirected" | "type">
type BodyReader = {
  cancel(reason?: unknown): Promise<void>
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>
}
type BodyTimeoutState = {
  active: number
  cancelers: Set<(reason: unknown) => Promise<void>>
  error?: Error
  finished: boolean
}

function responseMetadata(response: Response, metadata: ResponseMetadata, clone: () => Response): Response {
  Object.defineProperties(response, {
    url: { configurable: true, value: metadata.url },
    redirected: { configurable: true, value: metadata.redirected },
    type: { configurable: true, value: metadata.type },
    clone: {
      configurable: true,
      writable: true,
      value: clone,
    },
  })
  return response
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}
