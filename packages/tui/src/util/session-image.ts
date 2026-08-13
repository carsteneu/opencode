import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Marked, type Tokens } from "marked"
import { isSessionDataImageUri, sessionImageIdentity, validSessionImageUri } from "./session-image-load"

const supportedMime = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const maxSources = 24
// A one-row viewport wobble can move two competing center distances by two rows.
const nativeHysteresisRows = 2
const markdown = new Marked()
const textPartImages = new WeakMap<object, { text: string; images: SessionImage[] }>()

export const SESSION_IMAGE_NATIVE_LIMIT = 2
export const SESSION_IMAGE_NATIVE_RETAIN_VIEWPORTS = 0.75
export const SESSION_IMAGE_PREFETCH_LIMIT = 2
export const SESSION_IMAGE_PREFETCH_VIEWPORTS = 1

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

export function sessionImageAuto(image: SessionImage) {
  return image.source === "markdown" || isSessionDataImageUri(image.uri)
}

export function selectViewportSessionImageKeys(
  images: readonly { key: string; y: number; height: number }[],
  viewportY: number,
  viewportHeight: number,
  limit = 1,
  overscan = 1,
  direction = 0,
) {
  if (limit <= 0 || viewportHeight <= 0) return new Set<string>()
  return new Set(
    rankViewportSessionImages(images, viewportY, viewportHeight, overscan, Math.sign(direction))
      .slice(0, limit)
      .map((image) => image.key),
  )
}

export function planSessionImageResidency(
  images: readonly { key: string; y: number; height: number }[],
  viewportY: number,
  viewportHeight: number,
  previous: ReadonlySet<string>,
  input: { limit?: number; retainViewports?: number; direction?: number } = {},
) {
  const limit = Math.min(input.limit ?? SESSION_IMAGE_NATIVE_LIMIT, SESSION_IMAGE_NATIVE_LIMIT)
  if (limit <= 0 || viewportHeight <= 0) return new Set<string>()
  const viewportEnd = viewportY + viewportHeight
  const visible = new Set(
    images
      .filter((image) => rangesOverlap(image.y, image.y + Math.max(1, image.height), viewportY, viewportEnd))
      .map((image) => image.key),
  )
  const direction = Math.sign(input.direction ?? 0)
  return new Set(
    rankViewportSessionImages(
      images,
      viewportY,
      viewportHeight,
      Math.max(0, input.retainViewports ?? SESSION_IMAGE_NATIVE_RETAIN_VIEWPORTS),
      direction,
      previous,
    )
      .filter((image) => visible.has(image.key) || previous.has(image.key))
      .slice(0, limit)
      .map((image) => image.key),
  )
}

function rankViewportSessionImages(
  images: readonly { key: string; y: number; height: number }[],
  viewportY: number,
  viewportHeight: number,
  overscan: number,
  direction = 0,
  previous?: ReadonlySet<string>,
) {
  const viewportEnd = viewportY + viewportHeight
  const overscanSize = viewportHeight * Math.max(0, overscan)
  const overscanStart = viewportY - overscanSize
  const overscanEnd = viewportEnd + overscanSize
  const viewportCenter = viewportY + viewportHeight / 2
  return images
    .filter((image) => rangesOverlap(image.y, image.y + Math.max(1, image.height), overscanStart, overscanEnd))
    .toSorted((a, b) => {
      const aEnd = a.y + Math.max(1, a.height)
      const bEnd = b.y + Math.max(1, b.height)
      const aVisible = rangesOverlap(a.y, aEnd, viewportY, viewportEnd)
      const bVisible = rangesOverlap(b.y, bEnd, viewportY, viewportEnd)
      if (aVisible !== bVisible) return aVisible ? -1 : 1
      const distance = rangeDistance(a.y, aEnd, viewportY, viewportEnd)
      const nextDistance = rangeDistance(b.y, bEnd, viewportY, viewportEnd)
      if (distance !== nextDistance) return distance - nextDistance
      const center = Math.abs(a.y + Math.max(1, a.height) / 2 - viewportCenter)
      const nextCenter = Math.abs(b.y + Math.max(1, b.height) / 2 - viewportCenter)
      const centerRank = center - (aVisible && previous?.has(a.key) ? nativeHysteresisRows : 0)
      const nextCenterRank = nextCenter - (bVisible && previous?.has(b.key) ? nativeHysteresisRows : 0)
      if (centerRank !== nextCenterRank) return centerRank - nextCenterRank
      if (aVisible && previous?.has(a.key) !== previous?.has(b.key)) return previous?.has(a.key) ? -1 : 1
      const directional = direction > 0 ? b.y - a.y : a.y - b.y
      if (directional !== 0) return directional
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })
}

export function projectSessionImages(images: readonly SessionImage[], limit = 1) {
  const visible = images.slice(0, Math.max(0, limit))
  return {
    visible,
    hidden: images.length - visible.length,
  }
}

export function sessionImagePreviewActive(input: {
  supported: boolean
  dialogOpen: boolean
  resident: boolean
  failed: boolean
}) {
  return input.supported && !input.dialogOpen && input.resident && !input.failed
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

function rangeDistance(start: number, end: number, viewportStart: number, viewportEnd: number) {
  if (end <= viewportStart) return viewportStart - end
  if (start >= viewportEnd) return start - viewportEnd
  return 0
}

function rangesOverlap(start: number, end: number, viewportStart: number, viewportEnd: number) {
  return end > viewportStart && start < viewportEnd
}
