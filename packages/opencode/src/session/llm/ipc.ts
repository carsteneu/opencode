const binary = "__opencode_uint8array__"
const error = "__opencode_error__"

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

export const LLMWorkerIPC = { stringify, parse }
