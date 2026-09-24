// Bridges the session transcript (routes/session) with plugin panes so either
// side can follow the other's scroll position. The route registers a host per
// mounted session; adapters hand the host to plugins through TuiPluginApi.
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"

export type MessageAnchorHost = {
  anchors: Map<string, BoxRenderable>
  scroll: () => ScrollBoxRenderable | undefined
  // Bring the message's anchor into view, growing the render window and
  // loading older transcript pages when needed. Returns false when the route
  // declines (different session mounted, shutdown).
  scrollIntoView: (messageID: string) => boolean
}

const hosts = new Map<string, MessageAnchorHost>()
// Session-agnostic by design: callbacks receive the topmost visible messageID
// and decide themselves whether their pane cares (pane and route may briefly
// disagree across a session switch).
const visibleCallbacks = new Set<(messageID: string | undefined) => void>()

export function registerMessageAnchors(sessionID: string, host: MessageAnchorHost): () => void {
  hosts.set(sessionID, host)
  return () => {
    if (hosts.get(sessionID) === host) hosts.delete(sessionID)
  }
}

export function scrollToMessage(sessionID: string, messageID: string): boolean {
  return hosts.get(sessionID)?.scrollIntoView(messageID) ?? false
}

export function onMessageVisible(sessionID: string, callback: (messageID: string | undefined) => void): () => void {
  visibleCallbacks.add(callback)
  return () => visibleCallbacks.delete(callback)
}

export function notifyMessageVisible(messageID: string | undefined): void {
  for (const callback of visibleCallbacks) callback(messageID)
}
