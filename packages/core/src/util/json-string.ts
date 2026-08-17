export * as JsonString from "./json-string"

/** Incrementally count the UTF-8 bytes of one JSON-serialized string without allocating it. */
export function counter(maximum: number) {
  let bytes = maximum < 2 ? maximum + 1 : 2
  let pendingHigh = false
  let exceeded = maximum < 2

  const add = (size: number) => {
    if (bytes + size <= maximum) {
      bytes += size
      return true
    }
    bytes = maximum + 1
    exceeded = true
    return false
  }

  const write = (value: string, start = 0, end = value.length) => {
    if (exceeded) return false
    for (let index = start; index < end; index++) {
      const code = value.charCodeAt(index)
      if (pendingHigh) {
        pendingHigh = false
        if (code >= 0xdc00 && code <= 0xdfff) {
          if (!add(4)) return false
          continue
        }
        if (!add(6)) return false
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        pendingHigh = true
        continue
      }
      const size =
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : code <= 0x1f
            ? 6
            : code <= 0x7f
              ? 1
              : code <= 0x7ff
                ? 2
                : code >= 0xdc00 && code <= 0xdfff
                  ? 6
                  : 3
      if (!add(size)) return false
    }
    return true
  }

  const end = () => {
    if (!exceeded && pendingHigh) {
      pendingHigh = false
      add(6)
    }
    return bytes
  }

  return { write, end }
}

export function bytesUpTo(value: string, maximum: number) {
  const result = counter(maximum)
  result.write(value)
  return result.end()
}
