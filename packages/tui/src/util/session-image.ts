import type { ToolPart } from "@opencode-ai/sdk/v2"

const supportedMime = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const outputImage =
  /data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+={0,2}(?![a-z0-9+/=])|https?:\/\/[^\s<>"'`()[\]{}]+/gi
const supportedExtension = /\.(?:png|jpe?g|webp|gif)$/i
const maxSources = 24

export type SessionImage = {
  uri: string
  label: string
  source: "attachment" | "output"
}

export function toolSessionImages(state: ToolPart["state"]): SessionImage[] {
  if (state.status !== "completed") return []

  const seen = new Set<string>()
  const images = (state.attachments ?? [])
    .flatMap((attachment): SessionImage[] => {
      if (!supportedMime.has(attachment.mime.toLowerCase())) return []
      if (!/^(?:https?:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i.test(attachment.url)) return []
      return [
        {
          uri: attachment.url,
          label: attachment.filename ?? "Tool image",
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

  for (const match of state.output.matchAll(outputImage)) {
    if (images.length >= maxSources) break
    const data = match[0].slice(0, 5).toLowerCase() === "data:"
    const uri = data ? match[0] : match[0].replace(/[.,;:!]+$/, "")
    const parsed = data ? undefined : URL.parse(uri)
    if (!data && !parsed) continue
    if (parsed && !supportedExtension.test(parsed.pathname)) continue
    if (seen.has(uri)) continue
    seen.add(uri)
    images.push({ uri, label: "Tool output image", source: "output" })
  }

  return images
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
