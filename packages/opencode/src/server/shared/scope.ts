import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { release as releaseInstance, retain as retainInstance } from "./instances"

// Opt-in per-subscriber isolation for the global event stream.
//
// The stream is read by more than the TUI: `opencode run`, ACP, the app and the
// workspace control-plane all subscribe to /global/event. So filtering is NEVER
// global — it applies only to a client that has declared a scope. A subscriber
// without a scope receives the stream bit-for-bit as before, which also keeps
// older clients that do not know about scopes working.
//
// A scope is a directory, a project and the set of root sessions the client
// currently shows. The visible set is the closure over the parentID tree,
// computed from session lifecycle events observed on the bus, so subagent
// sessions that do not exist yet at declaration time still count.
//
// The project is what separates "the session list this window renders" (which is
// project-wide) from "a foreign project's session metadata" (which must never
// cross a window boundary).

export type ScopeInput = {
  readonly directory?: string
  readonly project?: string
  readonly sessions: ReadonlyArray<string>
}

export type Scope = {
  readonly directory: string
  readonly project: string
  readonly sessions: ReadonlySet<string>
}

type Entry = {
  directory: string
  project: string
  roots: Set<string>
  visible: Set<string>
}

const entries = new Map<string, Entry>()
const childrenOf = new Map<string, Set<string>>()
let observing = false

// Session list/status events (R4): these are what the session list renders —
// title, cost, tokens, live status, deletions — and it lists the whole project,
// not just the window's directory (a window at the repo root asks the list for
// path "" and gets every session of the project, session.ts list). So R4 is keyed
// on the project. It is NOT shared across projects: natively each window had its
// own server with exactly one project, so a foreign project's SessionInfo (title,
// directory, cost, tokens, share url) never crossed a window boundary and must
// not now.
const SESSION_STATUS = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "tui.session.select",
])

// Location-bound, non-session events: delivered only to the window whose own
// directory matches. The set is explicit on purpose — an unknown type falls
// through to "deliver", so a new upstream event never silently disappears.
const DIRECTORY_BOUND = new Set([
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  "integration.connection.updated",
  "mcp.tools.changed",
  "mcp.browser.open.failed",
  "models-dev.refreshed",
  "lsp.updated",
  "file.edited",
  "file.watcher.updated",
  "project.directories.updated",
  "plugin.added",
  "vcs.branch.updated",
  "pty.created",
  "pty.updated",
  "pty.deleted",
  "pty.exited",
  "worktree.ready",
  "worktree.failed",
  "server.instance.disposed",
])

export function installScopeTracking() {
  if (observing) return
  observing = true
  GlobalBus.on("event", (event) => observe(event.payload))
}

export function setScope(clientID: string, input: ScopeInput) {
  const directory = input.directory ?? ""
  const project = input.project ?? ""
  const previous = entries.get(clientID)
  // A window re-declares on every session switch and may move to another
  // directory, so the refcount has to follow the window: release the directory it
  // left, retain the one it declares now. Unguarded retains would leak a client
  // per declaration and keep the instance alive forever.
  //
  // A declaration that lands after this client's last stream was torn down
  // re-creates the entry — and its retain — with nothing left to clear it, so the
  // directory can stay resident until that window declares again or the server
  // exits. Closing that window needs this registry to know the stream lifetime;
  // it is not done here because a client may legitimately declare before its
  // stream opens.
  if (previous && previous.directory !== directory) releaseInstance(previous.directory)
  if (previous?.directory !== directory) retainInstance(directory)
  const entry: Entry = {
    directory,
    project,
    roots: new Set(input.sessions.filter((id) => typeof id === "string" && id.length > 0)),
    visible: new Set(),
  }
  entries.set(clientID, entry)
  expand(entry)
}

export function clearScope(clientID: string) {
  const previous = entries.get(clientID)
  if (previous) releaseInstance(previous.directory)
  entries.delete(clientID)
}

export function getScope(clientID: string): Scope | undefined {
  const entry = entries.get(clientID)
  if (!entry) return undefined
  return { directory: entry.directory, project: entry.project, sessions: entry.visible }
}

// An empty scope: location-less events still pass (R2), everything foreign is
// dropped. Used as the fail-closed fallback below.
const EMPTY: Scope = { directory: "", project: "", sessions: new Set() }

/**
 * Decision for a subscriber identified by the opt-in `x-opencode-client-id`
 * header. A subscriber that did NOT present the header is not opting in and gets
 * the full stream (run, ACP, app, control-plane). A subscriber that DID present
 * it has opted in, so it is filtered from the very first frame — the scope POST
 * that carries the directory/sessions is a few milliseconds behind the stream,
 * and until it lands the client is treated as showing nothing rather than
 * everything. Without this the window would see foreign project data during that
 * gap, which is exactly what §7 forbids.
 */
export function allowsForClient(clientID: string | undefined, event: GlobalBusEvent): boolean {
  if (!clientID) return true
  const entry = entries.get(clientID)
  return allows(event, entry ? { directory: entry.directory, project: entry.project, sessions: entry.visible } : EMPTY)
}

/** Pure decision function: may this event be delivered to a scoped client? */
export function allows(event: GlobalBusEvent, scope: Scope): boolean {
  const directory = event.directory
  // R2: location-less events (including the "global" sentinel) go to everyone.
  if (directory === undefined || directory === "global") return true

  const frame = frameOf(event.payload)
  if (!frame) return true

  // R1: location-bound non-session events only for the own directory.
  if (DIRECTORY_BOUND.has(frame.type)) return directory === scope.directory

  // R4: session list/status reaches the whole project the window shows.
  if (SESSION_STATUS.has(frame.type)) {
    const own = frame.sessionID !== undefined && scope.sessions.has(frame.sessionID)
    // Both sides know their project: that is the whole decision. The session list
    // is project-wide (see SESSION_STATUS), so the title, cost, status and
    // deletion of a session living in a sibling directory of this project must
    // still arrive or the list goes stale — and a foreign project's must not,
    // even if its directory string happens to match.
    if (scope.project !== "" && event.project !== undefined) return event.project === scope.project || own
    // No project on one side (an older client, or an event published without an
    // instance context): narrow decision — own directory, or a session this
    // window actually shows (a /move-ed session).
    return directory === scope.directory || own
  }

  // R3: session content only for the own session tree.
  if (frame.sessionID) return scope.sessions.has(frame.sessionID)

  // In doubt: deliver.
  return true
}

function expand(entry: Entry) {
  const next = new Set<string>()
  const stack = [...entry.roots]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (next.has(id)) continue
    next.add(id)
    const kids = childrenOf.get(id)
    if (kids) for (const kid of kids) stack.push(kid)
  }
  entry.visible = next
}

function observe(payload: unknown) {
  const frame = frameOf(payload)
  if (!frame) return
  if (frame.type !== "session.created" && frame.type !== "session.updated") return
  const data = dataOf(payload)
  const info = data?.info as Record<string, unknown> | undefined
  if (!info || typeof info.id !== "string") return
  const parentID = typeof info.parentID === "string" ? info.parentID : undefined
  if (!parentID) return
  const kids = childrenOf.get(parentID)
  if (kids) {
    if (!kids.has(info.id)) kids.add(info.id)
  } else {
    childrenOf.set(parentID, new Set([info.id]))
  }
  for (const entry of entries.values()) {
    if (!entry.visible.has(parentID)) continue
    entry.visible.add(info.id)
    expand(entry)
  }
}

type Frame = { type: string; sessionID?: string }

function frameOf(payload: unknown): Frame | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const value = payload as Record<string, unknown>
  if (value.type === "sync") {
    const sync = value.syncEvent as Record<string, unknown> | undefined
    if (!sync || typeof sync !== "object") return undefined
    const raw = typeof sync.type === "string" ? sync.type : ""
    if (raw === "") return undefined
    const data = sync.data as Record<string, unknown> | undefined
    return {
      type: raw.replace(/\.\d+$/, ""),
      sessionID: typeof data?.sessionID === "string" ? data.sessionID : undefined,
    }
  }
  if (typeof value.type !== "string") return undefined
  const properties = value.properties as Record<string, unknown> | undefined
  return {
    type: value.type,
    sessionID: typeof properties?.sessionID === "string" ? properties.sessionID : undefined,
  }
}

function dataOf(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const value = payload as Record<string, unknown>
  const properties = value.properties as Record<string, unknown> | undefined
  if (properties) return properties
  const sync = value.syncEvent as Record<string, unknown> | undefined
  return sync?.data as Record<string, unknown> | undefined
}

export * as SharedScope from "./scope"
