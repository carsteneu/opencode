/** @jsxImportSource @opentui/solid */
import { ImageRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"
import type { PromptFileAttachment, SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./tui-client"
import { sizedImage } from "./sized-image"

/** Transcript image harness: the session shell, the message shapes and the render entry point. */

export const TERMINAL_WIDTH = 112
// The session frame takes 4 columns off the terminal before the transcript row starts.
export const TRANSCRIPT_WIDTH = TERMINAL_WIDTH - 4

export function sessionAt(directory: string) {
  return {
    id: "ses_images",
    title: "Images",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

export function attachment(dataUri: string, name: string): PromptFileAttachment {
  return {
    data: dataUri.slice(dataUri.indexOf(",") + 1),
    mime: "image/png",
    source: { type: "inline" },
    name,
    mention: { start: 0, end: 0, text: `[Image ${name}]` },
  }
}

export function userMessage(files: PromptFileAttachment[]): SessionMessageInfo {
  return { type: "user", id: "user-0", text: "Look at this", time: { created: 0 }, files }
}

export function toolMessage(uris: string[]): SessionMessageInfo {
  return {
    type: "assistant",
    id: "assistant-0",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 1, completed: 2 },
    content: uris.map((uri, index) => ({
      type: "tool",
      id: `tool-${index}`,
      name: "read",
      time: { created: 2 },
      state: {
        status: "completed",
        input: { filePath: "shot.png" },
        metadata: {},
        content: [{ type: "file", uri, mime: "image/png", name: "shot.png" }],
      },
    })),
  } as unknown as SessionMessageInfo
}

export function textMessage(text: string, id = "assistant-0"): SessionMessageInfo {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 1, completed: 2 },
    content: [{ type: "text", id: `${id}-text`, text }],
  } as unknown as SessionMessageInfo
}

export function historyMessage(index: number): SessionMessageInfo {
  return {
    type: "user",
    id: `history-${index}`,
    text: `History message ${String(index).padStart(4, "0")}`,
    time: { created: index },
  }
}

/** A real image file on disk: the preview loader reads bytes, not names. */
export async function imageFile(state: string, name: string, width: number, height: number) {
  const target = path.join(state, name)
  await writeFile(target, Buffer.from(sizedImage(width, height).split(",")[1]!, "base64"))
  return target
}

export const markdownBody = (target: string, label = "chart") => `Shot:\n\n![${label}](<${target}>)\n`

/** One matrix row: the transcript, the session directory, and how the preview should start out. */
export type SessionImageFixture = {
  messages: SessionMessageInfo[]
  directory: string
  mountedAtStart: boolean
  marker?: string
}

export async function renderSession(
  statePath: string,
  messages: SessionMessageInfo[],
  options: {
    imagePreview?: boolean
    running?: boolean
    width?: number
    height?: number
    directory?: string
    onRequest?: (url: URL, request: Request) => void
  } = {},
) {
  const setup = await createTestRenderer({
    width: options.width ?? TERMINAL_WIDTH,
    height: options.height ?? 34,
    useThread: false,
    kittyKeyboard: true,
  })
  // oxlint-disable-next-line no-restricted-globals -- OpenTUI does not expose test resolution mutation publicly.
  Reflect.set(setup.renderer, "_resolution", { width: 800, height: 720 })
  setup.renderer.start()
  const session = sessionAt(options.directory ?? directory)
  const calls = createFetch((url, request) => {
    options.onRequest?.(url, request)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: options.running ? { [session.id]: {} } : {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({
          animations: false,
          tabs: { enabled: false },
          session: { image_preview: options.imagePreview ?? true },
        }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: statePath })), Effect.provide(FileSystem.layerNoop({}))),
  )
  return { setup, server, task }
}

export function collectImages(node: Renderable, found: ImageRenderable[] = []): ImageRenderable[] {
  if (node instanceof ImageRenderable) found.push(node)
  for (const child of node.getChildren()) collectImages(child, found)
  return found
}

export function findTranscript(root: Renderable, id: string): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && root.getRenderable(id)) return root
  return root
    .getChildren()
    .map((child) => findTranscript(child, id))
    .find(Boolean)
}

export { sizedImage }
