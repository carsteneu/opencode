import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

const DATA_IMAGE = /^data:([^;,]+);base64,(.*)$/s
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** The decoded preview bytes; previews are inline `data:` URLs, so no load step is needed. */
export function decodeSessionImage(uri: string): Uint8Array {
  const match = DATA_IMAGE.exec(uri)
  if (!match) throw new Error("Image preview is not a base64 data URL")
  const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  if (data.length === 0) throw new Error("Image preview contains no data")
  return new Uint8Array(data)
}

/** Filename with the extension the data URL declares, so the bytes stay openable after the save. */
export function sessionImageFilename(uri: string, label?: string) {
  const match = DATA_IMAGE.exec(uri)
  if (!match) throw new Error("Image preview is not a base64 data URL")
  const extension = MIME_EXTENSION[match[1].toLowerCase()] ?? "png"
  const stem = (label ?? "")
    .replace(IMAGE_EXTENSION, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
  return `${stem || "opencode-image"}.${extension}`
}

/** Write the preview bytes into `directory`, creating it, and return the path actually used. */
export async function saveSessionImage(uri: string, directory: string, label?: string): Promise<string> {
  if (!directory.trim()) throw new Error("Image save directory is required")
  if (directory.includes("\0")) throw new Error("Image save directory is invalid")
  const data = decodeSessionImage(uri)
  const filename = sessionImageFilename(uri, label)
  await mkdir(directory, { recursive: true })
  return publishUnique(directory, filename, data)
}

async function publishUnique(directory: string, filename: string, data: Uint8Array, attempt = 1): Promise<string> {
  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  const target = path.join(directory, attempt === 1 ? filename : `${stem}-${attempt}${extension}`)
  // `wx` fails instead of overwriting, so a concurrent save cannot clobber an earlier image.
  return writeFile(target, data, { flag: "wx" }).then(
    () => target,
    (error) => {
      if (isFileExists(error)) return publishUnique(directory, filename, data, attempt + 1)
      throw error
    },
  )
}

function isFileExists(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
