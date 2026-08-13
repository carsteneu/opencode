import path from "node:path"
import { link, mkdir, rm, writeFile } from "node:fs/promises"
import { imageInfo } from "@opentui/core"
import type { SessionImage } from "./session-image"
import { isSessionDataImageUri, loadSessionImageSource } from "./session-image-load"

const imageExtension = /\.(png|jpe?g|webp|gif)$/i

export async function saveSessionImage(
  image: SessionImage,
  directory: string,
  signal?: AbortSignal,
  source?: Uint8Array,
) {
  const data = source ?? (await loadSessionImageSource(image.uri, signal))
  signal?.throwIfAborted()
  const filename = sessionImageFilename(image, data)
  await mkdir(directory, { recursive: true })
  signal?.throwIfAborted()
  const temporary = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`)
  return writeFile(temporary, data, { flag: "wx", signal })
    .then(() => publishUnique(temporary, directory, filename, signal))
    .then(
      async (target) => {
        await rm(temporary, { force: true }).catch(() => undefined)
        return target
      },
      async (error) => {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      },
    )
}

export function sessionImageFilename(image: SessionImage, data: Uint8Array) {
  const uriName = isSessionDataImageUri(image.uri) ? "" : (URL.parse(image.uri)?.pathname.split("/").at(-1) ?? "")
  const source = /^(?:image|tool image)$/i.test(image.label) ? uriName || "opencode-image" : image.label
  const stem = source
    .replace(imageExtension, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
  const format = imageInfo(data).format
  const filename = stem || "opencode-image"
  const portable = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ? `_${filename}` : filename
  return `${portable}.${format === "jpeg" ? "jpg" : format}`
}

async function publishUnique(
  temporary: string,
  directory: string,
  filename: string,
  signal?: AbortSignal,
  attempt = 1,
): Promise<string> {
  signal?.throwIfAborted()
  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  const target = path.join(directory, attempt === 1 ? filename : `${stem}-${attempt}${extension}`)
  return link(temporary, target).then(
    () => target,
    (error) => {
      if (isFileExists(error)) return publishUnique(temporary, directory, filename, signal, attempt + 1)
      throw error
    },
  )
}

function isFileExists(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
