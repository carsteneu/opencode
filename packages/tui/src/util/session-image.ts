import type { ToolPart } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

const supportedMime = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const dataImage = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i
const maxSources = 24
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export type SessionImage = {
  uri: string
  label: string
  source: "attachment" | "output"
}

export function toolSessionImages(part: ToolPart): SessionImage[] {
  if (part.state.status !== "completed") return []

  const seen = new Set<string>()
  const images = (part.state.attachments ?? [])
    .flatMap((attachment): SessionImage[] => {
      if (!supportedMime.has(attachment.mime.toLowerCase())) return []
      const uri = imageUri(attachment.url)
      if (!uri) return []
      return [
        {
          uri,
          label: imageLabel(attachment.filename),
          source: "attachment",
        },
      ]
    })
    .filter((image) => {
      if (seen.has(image.uri)) return false
      seen.add(image.uri)
      return true
    })
    .slice(0, maxSources)

  const generated = generatedCapImage(part)
  if (!generated || images.length >= maxSources || seen.has(generated.uri)) return images
  images.push(generated)
  return images
}

export function sessionImageKey(partID: string, uri: string) {
  return `${partID}\0${uri}`
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
          .slice(0, 3)
          .filter((image) => image.source === "output" || dataImage.test(image.uri))
          .map((image) => sessionImageKey(part.partID, image.uri)),
      )
      .slice(-limit),
  )
}

export function projectSessionImages(images: readonly SessionImage[], limit = 3) {
  const visible = images.slice(0, Math.max(0, limit))
  return {
    visible,
    hidden: images.length - visible.length,
  }
}

export function sessionImagePreviewHeight(terminalHeight: number) {
  return Math.max(4, Math.min(8, Math.floor(terminalHeight / 4)))
}

function generatedCapImage(part: ToolPart): SessionImage | undefined {
  if (part.tool !== "yesmem_execute_cap" || part.state.status !== "completed") return
  const wrapper = jsonRecord(part.state.output)
  if (wrapper?.cap_name !== "generate_image") return
  const output = typeof wrapper.output === "string" ? jsonRecord(wrapper.output) : record(wrapper.output)
  if (!output || typeof output.url !== "string") return
  const uri = imageUri(output.url)
  if (!uri) return
  return { uri, label: "Generated image", source: "output" }
}

function imageUri(value: string) {
  if (value !== value.trim()) return
  if (dataImage.test(value)) return value
  const url = URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password) return
  return value
}

function imageLabel(value: string | undefined) {
  const label = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120)
  return label || "Tool image"
}

function jsonRecord(value: string) {
  return record(Option.getOrUndefined(decodeJson(value)))
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
