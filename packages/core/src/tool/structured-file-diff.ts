export * as StructuredFileDiff from "./structured-file-diff"

import { FileDiff } from "@opencode-ai/schema/file-diff"
import { JsonString } from "../util/json-string"

/** Keep structured patch sets aligned with the largest set the TUI previews inline. */
export const MAX_PATCH_BYTES = 256 * 1024

export function bound(files: ReadonlyArray<FileDiff.Info>) {
  let remaining = MAX_PATCH_BYTES
  const exceeded = files.some((file) => {
    if (file.patch === undefined) return false
    const bytes = JsonString.bytesUpTo(file.patch, remaining)
    if (bytes > remaining) return true
    remaining -= bytes
    return false
  })
  if (!exceeded) return files
  return files.map((file) => ({ ...file, patch: undefined }))
}
