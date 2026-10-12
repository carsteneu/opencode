// Idealized B2 worker: receives only the appended suffix and keeps the stable prefix.
/// <reference lib="webworker" />
import { project, stream, type Projection } from "../packages/session-ui/src/components/markdown-stream"

const projects = new Map<string, Projection>()

self.onmessage = (event: MessageEvent<{ id: number; key: string; suffix: string }>) => {
  const { id, key, suffix = "" } = event.data
  const previous = projects.get(key)
  const text = (previous?.text ?? "") + suffix
  const tail = previous?.blocks.at(-1)
  const next =
    previous && tail?.mode === "live" && !suffix.includes("\n") && !previous.text.endsWith("\n")
      ? {
          text,
          blocks: [
            ...previous.blocks.slice(0, -1),
            { ...tail, raw: tail.raw + suffix, src: stream(tail.raw + suffix, true).at(-1)?.src ?? tail.raw },
          ],
        }
      : project(previous, text, true)
  projects.set(key, next)
  self.postMessage({ id, blocks: next.blocks })
}
