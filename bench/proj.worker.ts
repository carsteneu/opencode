// Current v2 worker behaviour: receives the FULL text per delta and re-lexes it.
/// <reference lib="webworker" />
import { project, type Projection } from "../packages/session-ui/src/components/markdown-stream"

const projections = new Map<string, Projection>()

self.onmessage = (event: MessageEvent<{ id: number; key: string; text: string }>) => {
  const { id, key, text } = event.data
  if (typeof text !== "string") throw new Error("project payload text must be a string")
  const next = project(projections.get(key), text, true)
  projections.set(key, next)
  self.postMessage({ id, blocks: next.blocks })
}
