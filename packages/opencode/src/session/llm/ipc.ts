const binary = "__opencode_uint8array__"
const error = "__opencode_error__"

export function stringify(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return { [binary]: Buffer.from(item).toString("base64") }
    if (item instanceof Error) return { [error]: item.message, name: item.name, stack: item.stack }
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
