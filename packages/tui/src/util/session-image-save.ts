import path from "node:path"
import { link, mkdir, rm, writeFile } from "node:fs/promises"

// Inline previews are `data:` URIs, so saving a previewed image is a local decode plus write.
const dataImage = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s
const base64Payload = /^[a-z0-9+/]+={0,2}$/i
const labelExtension = /\.(png|jpe?g|webp|gif)$/i
const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

export function sessionImageFilename(uri: string, label?: string) {
  const mediaType = decodeSessionImage(uri).mediaType
  const named = (label ?? "").trim()
  const extension = extensions[mediaType] ?? labelExtension.exec(named)?.[1].toLowerCase() ?? "bin"
  const stem = named
    .replace(labelExtension, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
  const filename = stem || "opencode-image"
  const portable = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ? `_${filename}` : filename
  return `${portable}.${extension}`
}

/** Writes a previewed image into `directory`, picking a free name and never overwriting an existing file. */
export async function saveSessionImage(uri: string, directory: string, label?: string) {
  const data = decodeSessionImage(uri).data
  const filename = sessionImageFilename(uri, label)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data, { flag: "wx" })
    return await publishUnique(temporary, directory, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function decodeSessionImage(uri: string) {
  const match = dataImage.exec(uri)
  const payload = match?.[2] ?? ""
  if (!match || payload.length % 4 === 1 || !base64Payload.test(payload)) {
    throw new Error("Only inline image data URIs can be saved")
  }
  return { mediaType: match[1]!.toLowerCase(), data: new Uint8Array(Buffer.from(payload, "base64")) }
}

async function publishUnique(
  temporary: string,
  directory: string,
  filename: string,
  attempt = 1,
): Promise<string> {
  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  const target = path.join(directory, attempt === 1 ? filename : `${stem}-${attempt}${extension}`)
  return link(temporary, target).then(
    () => target,
    (error) => {
      if (isFileExists(error)) return publishUnique(temporary, directory, filename, attempt + 1)
      throw error
    },
  )
}

function isFileExists(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
