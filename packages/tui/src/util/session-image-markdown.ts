import path from "node:path"
import type { SessionMessageAssistantText } from "@opencode/client"
import { localImagePath } from "@opencode/util/path"
import { Marked, type Tokens } from "marked"
import { validSessionImageUri } from "./session-image-load"

// v1 bounded one text part at this many sources.
export const MARKDOWN_IMAGE_LIMIT = 24

const markdown = new Marked()
const partSources = new WeakMap<
  object,
  { text: string; directory: string | undefined; images: MarkdownImageSource[] }
>()

export type MarkdownImageSource = {
  /** A validated remote or inline image URI, or an absolute local path. */
  source: string
  label: string
}

/**
 * The image references a markdown body declares, in the order they appear, deduplicated and bounded.
 * Lexed rather than pattern matched so that the sources markdown does not treat as images are not
 * treated as images here either: escaped, inline code, fenced or indented code, raw HTML, and plain
 * links all stay out.
 */
export function markdownImageSources(content: string, directory: string | undefined): MarkdownImageSource[] {
  if (!content.includes("![")) return []

  const seen = new Set<string>()
  const images: MarkdownImageSource[] = []
  markdown.walkTokens(markdown.lexer(content, { gfm: true }), (token) => {
    if (token.type !== "image" || images.length >= MARKDOWN_IMAGE_LIMIT) return
    const image = token as Tokens.Image
    const source = imageSource(image.href, directory)
    if (!source) return
    // Deduplicated on the whole source: two different inline payloads can share a length, a header and
    // a tail, and a fingerprint over those would silently drop the second image.
    if (seen.has(source)) return
    seen.add(source)
    images.push({ source, label: imageLabel(image.text, "Image") })
  })
  return images
}

/**
 * What one markdown image reference names. A remote or inline image is accepted exactly as the v1
 * loader accepted it; anything else is only accepted as a local file, resolved against the session
 * directory. A relative reference without a directory is skipped rather than resolved against the
 * process working directory, so the transcript never previews a file the session does not name.
 */
function imageSource(href: string, directory: string | undefined) {
  const uri = validSessionImageUri(href)
  if (uri) return uri
  const value = localImagePath(href)
  if (!value) return undefined
  if (value.startsWith("/") || /^[a-z]:\//i.test(value)) return value
  return directory ? path.resolve(directory, value) : undefined
}

/**
 * The previews for one text part, memoized on the part object with its text and directory so a
 * transcript frame never re-lexes the body. A part is only projected once its message is durably
 * complete (v1 also required the part's own end time, which v2 text parts do not carry) and only
 * while previews are enabled, so a body whose previews are switched off is never even read for
 * sources, let alone fetched.
 */
export function textPartImageSources(input: {
  part: Pick<SessionMessageAssistantText, "text">
  completed: boolean
  enabled: boolean
  directory: string | undefined
}) {
  if (!input.completed || !input.enabled) return []
  const cached = partSources.get(input.part)
  if (cached?.text === input.part.text && cached.directory === input.directory) return cached.images
  const images = markdownImageSources(input.part.text, input.directory)
  partSources.set(input.part, { text: input.part.text, directory: input.directory, images })
  return images
}

// C0, DEL and C1 controls plus the bidi overrides: a label is a filename and a line of text, so a
// character that can reorder or hide what surrounds it has no place in one.
const labelControls = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function imageLabel(value: string | undefined, fallback: string) {
  const label = value?.replace(labelControls, " ").trim().slice(0, 120)
  return label || fallback
}
