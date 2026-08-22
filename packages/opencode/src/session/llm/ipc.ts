const binary = "__opencode_uint8array__"
const error = "__opencode_error__"
const highWaterMark = 64 * 1024

// bun >=1.4 surfaces EPIPE from writes into a torn-down stdio channel as a
// fatal 'error' instead of swallowing it (oven-sh/bun#35064). Our worker
// legitimately races its peer closing the pipe, so treat broken pipe as a
// nil result at the sink layer (as bun <=1.3/node did).
function swallowBrokenPipe(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === "EPIPE") return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("EPIPE") || message.includes("broken pipe") || message.includes("EBADF")
}

export function stringify(value: unknown) {
  return JSON.stringify(value, function (key, item) {
    // Buffer.toJSON runs before the replacer, so inspect the holder's original
    // value to preserve Buffer and Uint8Array through the same binary envelope.
    const original = this[key]
    if (original instanceof Uint8Array) return { [binary]: Buffer.from(original).toString("base64") }
    if (original instanceof Error) return { [error]: original.message, name: original.name, stack: original.stack }
    return item
  })
}

export function parse(value: string) {
  return JSON.parse(value, (_key, item) =>
    item && typeof item === "object" && binary in item
      ? Uint8Array.from(Buffer.from(item[binary], "base64"))
      : item && typeof item === "object" && error in item
        ? Object.assign(new Error(String(item[error])), { name: item.name, stack: item.stack })
        : item,
  ) as unknown
}

export function lineReader(stream: ReadableStream<Uint8Array>) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const decoder = new TextDecoder()
  let fragments: string[] = []
  let ready: string[] = []
  let readyIndex = 0
  let ended = false

  const append = (value: string) => {
    let start = 0
    while (true) {
      const index = value.indexOf("\n", start)
      if (index === -1) break
      const fragment = value.slice(start, index)
      if (fragments.length === 0) ready.push(fragment)
      else {
        fragments.push(fragment)
        ready.push(fragments.join(""))
        fragments = []
      }
      start = index + 1
    }
    if (start < value.length) fragments.push(value.slice(start))
  }

  const take = () => {
    if (readyIndex >= ready.length) return undefined
    const result = ready[readyIndex++]
    if (readyIndex === ready.length) {
      ready = []
      readyIndex = 0
    }
    return result
  }

  const read = async (): Promise<string | undefined> => {
    while (true) {
      const line = take()
      if (line !== undefined) return line

      if (ended) {
        if (fragments.length === 0) return
        const result = fragments.join("")
        fragments = []
        return result
      }

      reader ??= stream.getReader()
      const result = await reader.read()
      if (result.done) {
        append(decoder.decode())
        ended = true
        continue
      }
      append(decoder.decode(result.value, { stream: true }))
    }
  }

  const release = () => {
    if (!reader) return
    reader.releaseLock()
    reader = undefined
  }
  const cancel = () => (reader ? reader.cancel() : stream.cancel())
  return { read, release, cancel }
}

export function writer(sink: ReturnType<typeof Bun.stdout.writer>) {
  sink.start({ highWaterMark })
  let writing = Promise.resolve()
  let writeError: unknown
  const enqueue = <T>(run: () => T | Promise<T>) => {
    const result = writing.then(async () => {
      if (writeError) throw writeError
      return run()
    })
    writing = result.then(
      () => undefined,
      (error) => {
        if (swallowBrokenPipe(error)) return
        writeError = error
      },
    )
    return result
  }

  const write = (value: unknown) =>
    enqueue(async () => {
      try {
        await sink.write(stringify(value) + "\n")
        await sink.flush()
      } catch (error) {
        if (swallowBrokenPipe(error)) return
        throw error
      }
    })
  const end = () =>
    enqueue(async () => {
      try {
        await sink.end()
      } catch (error) {
        if (swallowBrokenPipe(error)) return
        throw error
      }
    })
  return { write, end }
}

export const LLMWorkerIPC = { stringify, parse, lineReader, writer }
