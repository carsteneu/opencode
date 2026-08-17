export * as StructuredFileDiff from "./structured-file-diff"

import { FileDiff } from "@opencode-ai/schema/file-diff"

/** Keep structured patch sets aligned with the largest set the TUI previews inline. */
export const MAX_PATCH_BYTES = 256 * 1024

export function bound(files: ReadonlyArray<FileDiff.Info>) {
  let remaining = MAX_PATCH_BYTES
  const exceeded = files.some((file) => {
    if (file.patch === undefined) return false
    const bytes = jsonStringBytes(file.patch, remaining)
    if (bytes > remaining) return true
    remaining -= bytes
    return false
  })
  if (!exceeded) return files
  return files.map((file) => ({ ...file, patch: undefined }))
}

/** Count only through the caller's limit while matching JSON.stringify for string data. */
function jsonStringBytes(value: string, maximum: number) {
  let bytes = 2
  if (bytes > maximum) return maximum + 1
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const next = value.charCodeAt(index + 1)
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
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
              : pair
                ? 4
                : code >= 0xd800 && code <= 0xdfff
                  ? 6
                  : 3
    if (bytes + size > maximum) return maximum + 1
    bytes += size
    if (pair) index++
  }
  return bytes
}
