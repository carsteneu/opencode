import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

const DATA_IMAGE = /^data:([^;,]+);base64,(.*)$/s
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|ico|avif|bmp|tiff)$/i
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/ico": "ico",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
}
const IMAGE_SUBTYPE = /^image\/([a-z0-9][a-z0-9.+-]{0,29})$/i
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const WINDOWS_RESERVED = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PUBLISH_ATTEMPTS = 100

/** The decoded preview bytes; previews are inline `data:` URLs, so no load step is needed. */
export function decodeSessionImage(uri: string): Uint8Array {
  const match = DATA_IMAGE.exec(uri)
  if (!match) throw new Error("Image preview is not a base64 data URL")
  const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  if (data.length === 0) throw new Error("Image preview contains no data")
  return new Uint8Array(data)
}

/**
 * Filename with the extension the bytes actually are, so the saved file stays openable. The data URL's mime decides
 * first (any `image/*` subtype, not just the ones the preview renders), then the bytes are sniffed for the
 * `application/octet-stream` URLs the diff viewer sends.
 */
export function sessionImageFilename(uri: string, label?: string, data?: Uint8Array) {
  const match = DATA_IMAGE.exec(uri)
  if (!match) throw new Error("Image preview is not a base64 data URL")
  const mime = match[1].toLowerCase()
  const subtype = IMAGE_SUBTYPE.exec(mime)?.[1]
  const extension =
    (Object.hasOwn(MIME_EXTENSION, mime) ? MIME_EXTENSION[mime] : undefined) ??
    (subtype ? subtypeExtension(subtype) : undefined) ??
    sniffImageExtension(data) ??
    "png"
  const stem = (label ?? "")
    .replace(IMAGE_EXTENSION, "")
    .replace(UNSAFE_FILENAME, "-")
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
  const filename = stem || "opencode-image"
  return `${WINDOWS_RESERVED.test(filename) ? `_${filename}` : filename}.${extension}`
}

/**
 * A declared image subtype carries at most a hint of the extension: the `+…` part is a codec hint (`svg+xml`), and
 * the name itself can be dotted or `x-`-prefixed (`vnd.microsoft.icon`, `x-canon-cr2`), so the last segment is the
 * closest thing to one. Anything that is not a plausible extension falls through to the sniffer.
 */
function subtypeExtension(subtype: string) {
  const candidate = subtype.split("+")[0]?.split(/[.-]/).pop() ?? ""
  return /^[a-z0-9]{1,5}$/.test(candidate) ? candidate : undefined
}

function sniffImageExtension(data: Uint8Array | undefined) {
  if (!data) return undefined
  if (PNG_MAGIC.every((byte, index) => data[index] === byte)) return "png"
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg"
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "gif"
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) return "ico"
  const riff = data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
  const webp = data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  if (riff && webp) return "webp"
  return undefined
}

/**
 * What the user typed in the save prompt, resolved against the TUI's roots. `undefined` means the field was emptied,
 * which the caller must treat as an error rather than as "save into the process cwd".
 */
export function resolveSessionImageDirectory(input: string, roots: { home: string; cwd: string }) {
  const value = input.trim()
  if (value === "") return undefined
  if (value === "~") return roots.home
  if (value.startsWith("~/")) return path.resolve(roots.home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(roots.cwd, value)
}

/**
 * Write the preview bytes into `directory`, creating it, and return the path actually used. The directory is the
 * user's own input, so only the payload shape and the file mode are constrained here.
 */
export async function saveSessionImage(uri: string, directory: string, label?: string): Promise<string> {
  if (!directory.trim()) throw new Error("Image save directory is required")
  if (directory.includes("\0")) throw new Error("Image save directory is invalid")
  const data = decodeSessionImage(uri)
  const filename = sessionImageFilename(uri, label, data)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return publishUnique(directory, filename, data)
}

async function publishUnique(directory: string, filename: string, data: Uint8Array, attempt = 1): Promise<string> {
  if (attempt > MAX_PUBLISH_ATTEMPTS) throw new Error(`Image save directory ${directory} holds too many copies`)
  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  const target = path.join(directory, attempt === 1 ? filename : `${stem}-${attempt}${extension}`)
  // `wx` fails instead of overwriting, so a concurrent save cannot clobber an earlier image.
  return writeFile(target, data, { flag: "wx", mode: 0o600 }).then(
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
