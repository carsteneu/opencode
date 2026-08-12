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
    const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
    const signals: AbortSignal[] = []

    if (opts.signal) signals.push(opts.signal)
    if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
    if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
    if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
      signals.push(AbortSignal.timeout(options["timeout"] as number))

    const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    if (combined) opts.signal = combined

    const res = await (customFetch ?? fetch)(input, {
      ...opts,
      // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
      timeout: false,
    }).finally(() => headerTimeoutCtl?.clear())

    if (!chunkAbortCtl || chunkTimeout === undefined) return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
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
  })

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
