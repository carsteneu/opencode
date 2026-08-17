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
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new ProviderError.ResponseStreamError("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err).catch(() => undefined)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}
