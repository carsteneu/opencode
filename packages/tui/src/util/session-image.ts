import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Marked, type Tokens } from "marked"
import { isSessionDataImageUri, sessionImageIdentity, validSessionImageUri } from "./session-image-load"

const supportedMime = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const maxSources = 24
const markdown = new Marked()
const textPartImages = new WeakMap<object, { text: string; images: SessionImage[] }>()

export type SessionImage = {
  key: string
  uri: string
  label: string
  source: "attachment" | "markdown"
}

export function toolSessionImages(part: ToolPart): SessionImage[] {
  if (part.state.status !== "completed") return []

  const seen = new Set<string>()
  const images = (part.state.attachments ?? [])
    .flatMap((attachment): SessionImage[] => {
      if (!supportedMime.has(attachment.mime.toLowerCase())) return []
      const uri = validSessionImageUri(attachment.url)
      if (!uri) return []
      return [
        {
          key: `attachment:${attachment.id}`,
          uri,
          label: imageLabel(attachment.filename, "Tool image"),
          source: "attachment",
        },
      ]
    })
    .filter((image) => {
      const identity = sessionImageIdentity(image.uri)
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .slice(0, maxSources)
  return images
}

export function markdownSessionImages(content: string): SessionImage[] {
  if (!content.includes("![")) return []

  const seen = new Set<string>()
  const images: SessionImage[] = []
  markdown.walkTokens(markdown.lexer(content, { gfm: true }), (token) => {
    if (token.type !== "image" || images.length >= maxSources) return
    const image = token as Tokens.Image
    const uri = validSessionImageUri(image.href)
    if (!uri) return
    const identity = sessionImageIdentity(uri)
    if (seen.has(identity)) return
    seen.add(identity)
    images.push({
      key: `markdown:${images.length}`,
      uri,
      label: imageLabel(image.text, "Image"),
      source: "markdown",
    })
  })
  return images
}

export function textPartSessionImages(part: Pick<TextPart, "text" | "time">, messageCompleted: boolean) {
  if (!messageCompleted || (part.time && part.time.end === undefined)) return []
  const cached = textPartImages.get(part)
  if (cached?.text === part.text) return cached.images
  const images = markdownSessionImages(part.text)
  textPartImages.set(part, { text: part.text, images })
  return images
}

export function sessionImageKey(partID: string, imageKey: string) {
  return `${partID}\0${imageKey}`
}

export function selectAutoSessionImageKeys(
  parts: readonly { partID: string; images: readonly SessionImage[] }[],
  limit = 1,
) {
  if (limit <= 0) return new Set<string>()
  return new Set(
    parts
      .flatMap((part) =>
        part.images
          .slice(0, 1)
          .filter((image) => image.source === "markdown" || isSessionDataImageUri(image.uri))
          .map((image) => sessionImageKey(part.partID, image.key)),
      )
      .slice(-limit),
  )
}

export function projectSessionImages(images: readonly SessionImage[], limit = 1) {
  const visible = images.slice(0, Math.max(0, limit))
  return {
    visible,
    hidden: images.length - visible.length,
  }
}

export function sessionImagePreviewHeight(
  terminalHeight: number,
  availableColumns: number,
  sourceWidth = 16,
  sourceHeight = 9,
  cellAspectRatio = 2,
) {
  const minimum = Math.min(6, Math.max(1, terminalHeight))
  // Square terminal images need about one row per two columns; cap taller portraits at two viewports.
  const maximum = Math.max(minimum, terminalHeight * 2)
  const aspect = sourceWidth > 0 && sourceHeight > 0 ? (sourceWidth / sourceHeight) * cellAspectRatio : 1
  return Math.max(minimum, Math.min(maximum, Math.round(Math.max(1, availableColumns) / aspect)))
}

function imageLabel(value: string | undefined, fallback: string) {
  const label = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 120)
  return label || fallback
}
