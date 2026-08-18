import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

export const LOCAL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

type LocalRead = Readonly<{ type: "content"; content: Uint8Array }> | Readonly<{ type: "too-large" }>

export type LocalFiles = Readonly<{
  read(path: string, maxBytes: number): Promise<LocalRead | undefined>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>
  | Readonly<{ type: "error"; reason: "too-large"; maxBytes: number }>

export function readLocalAttachment(file: string) {
  return readLocalAttachmentWith(
    {
      read: readLocalFile,
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

const documentMimes = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])

export function localAttachmentKind(mime: string) {
  const type = mediaType(mime)
  if (type.startsWith("image/")) return "image" as const
  if (type === "application/pdf") return "pdf" as const
  return "file" as const
}

export async function readLocalAttachmentWith(files: LocalFiles, path: string): Promise<LocalAttachment | undefined> {
  const raw = await files.mime(path).catch(() => undefined)
  if (!raw) return
  const mime = mediaType(raw)
  if (
    mime !== "image/svg+xml" &&
    !mime.startsWith("image/") &&
    mime !== "application/pdf" &&
    !documentMimes.has(mime)
  ) {
    return
  }

  const file = await files.read(path, LOCAL_ATTACHMENT_MAX_BYTES).catch(() => undefined)
  if (!file) return
  if (file.type === "too-large") {
    return { type: "error", reason: "too-large", maxBytes: LOCAL_ATTACHMENT_MAX_BYTES }
  }
  if (mime === "image/svg+xml") {
    const content = new TextDecoder().decode(file.content)
    if (!content) return
    return { type: "text", mime, content }
  }
  return { type: "binary", mime, content: file.content }
}

function mediaType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream"
}

async function readLocalFile(path: string, maxBytes: number): Promise<LocalRead | undefined> {
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK
  const file = await open(path, flags)
  try {
    const before = await file.stat()
    if (!before.isFile()) return
    if (before.size > maxBytes) return { type: "too-large" }

    const content = Buffer.allocUnsafe(before.size)
    const offset = await readFully(file, content)
    const after = await file.stat()
    if (after.size > maxBytes) return { type: "too-large" }
    if (after.size !== before.size || offset !== before.size) return
    return { type: "content", content }
  } finally {
    await file.close()
  }
}

async function readFully(file: Awaited<ReturnType<typeof open>>, content: Uint8Array) {
  let offset = 0
  while (offset < content.byteLength) {
    const result = await file.read(content, offset, content.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  return offset
}
