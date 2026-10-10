import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { allows, allowsForClient, clearScope, getScope, installScopeTracking, setScope, type Scope } from "../../src/server/shared/scope"

const A = "/work/a"
const B = "/work/b"

let counter = 0
function clientID() {
  return `tui_test_${++counter}`
}

function scope(directory: string, sessions: string[]): Scope {
  return { directory, sessions: new Set(sessions) }
}

function live(type: string, sessionID?: string, directory?: string) {
  return {
    directory,
    payload: { id: "evt", type, properties: sessionID ? { sessionID } : {} },
  }
}

function sync(type: string, versioned: string, sessionID: string, directory?: string) {
  return {
    directory,
    payload: { type: "sync", syncEvent: { id: "evt", type: versioned, seq: 1, aggregateID: sessionID, data: { sessionID } } },
  }
}

describe("event scope filter", () => {
  test("R1: location-bound non-session events only for the own directory", () => {
    const own = scope(A, ["ses_a"])
    for (const type of [
      "catalog.updated",
      "reference.updated",
      "integration.updated",
      "mcp.tools.changed",
      "lsp.updated",
      "file.edited",
      "pty.created",
    ]) {
      expect(allows(live(type, undefined, A), own)).toBe(true)
      expect(allows(live(type, undefined, B), own)).toBe(false)
    }
  })

  test("R2: location-less events reach everyone", () => {
    const own = scope(A, [])
    expect(allows(live("project.updated", undefined, "global"), own)).toBe(true)
    expect(allows(live("project.updated", undefined, undefined), own)).toBe(true)
    expect(allows(live("server.instance.disposed", undefined, B), own)).toBe(false)
  })

  test("R3: session content only for the own session", () => {
    const own = scope(A, ["ses_a"])
    expect(allows(live("session.next.text.delta", "ses_a", A), own)).toBe(true)
    expect(allows(live("session.next.text.delta", "ses_b", A), own)).toBe(false)
    expect(allows(live("session.diff", "ses_b", A), own)).toBe(false)
    expect(allows(live("todo.updated", "ses_b", A), own)).toBe(false)
    expect(allows(live("message.updated", "ses_b", A), own)).toBe(false)
    expect(allows(live("message.part.updated", "ses_a", A), own)).toBe(true)
    expect(allows(live("permission.asked", "ses_b", A), own)).toBe(false)
    expect(allows(live("question.asked", "ses_a", A), own)).toBe(true)
  })

  test("R3: durable sync frames are filtered by the same session rule", () => {
    const own = scope(A, ["ses_a"])
    expect(allows(sync("session.next.step.started", "session.next.step.started.1", "ses_a", A), own)).toBe(true)
    expect(allows(sync("session.next.step.started", "session.next.step.started.1", "ses_b", A), own)).toBe(false)
  })

  test("R4: session status/list is project-wide only inside our own directory", () => {
    const own = scope(A, ["ses_a"])
    for (const type of ["session.created", "session.updated", "session.deleted", "session.status", "session.idle"]) {
      // Own directory: every session of the project is delivered, as before.
      expect(allows(live(type, "ses_b", A), own)).toBe(true)
      expect(allows(sync(type, `${type}.1`, "ses_b", A), own)).toBe(true)
      // Foreign directory: not delivered at all. Natively each window had its own
      // single-project server, so cross-project session metadata never existed;
      // delivering it here shares SessionInfo (title, directory, cost, tokens,
      // share url) of a foreign project.
      expect(allows(live(type, "ses_b", B), own)).toBe(false)
      expect(allows(sync(type, `${type}.1`, "ses_b", B), own)).toBe(false)
      // Foreign directory but one of our own sessions (a /move-ed session): the
      // live status must still arrive or the session list shows it as dark.
      expect(allows(live(type, "ses_a", B), own)).toBe(true)
      expect(allows(sync(type, `${type}.1`, "ses_a", B), own)).toBe(true)
    }
  })

  test("unknown events are delivered (in doubt, deliver)", () => {
    const own = scope(A, [])
    expect(allows(live("some.future.event", undefined, B), own)).toBe(true)
    expect(allows({ directory: B, payload: { id: "x", type: "brand.new", properties: {} } }, own)).toBe(true)
  })

  // Spec §7 asked for these two to be classified before implementation. Both
  // carry no session id and are emitted per instance, so they are location-bound
  // like catalog.updated — the hard rule "never data from a foreign project" wins
  // over the (otherwise correct) "in doubt, deliver" default. Measured: 45
  // plugin.added frames from dir A reached a window scoped to dir B before this.
  test("plugin.added and vcs.branch.updated are directory-bound (R1)", () => {
    const own = scope(A, [])
    expect(allows(live("plugin.added", undefined, A), own)).toBe(true)
    expect(allows(live("plugin.added", undefined, B), own)).toBe(false)
    expect(allows(live("vcs.branch.updated", undefined, A), own)).toBe(true)
    expect(allows(live("vcs.branch.updated", undefined, B), own)).toBe(false)
  })
})

describe("event scope registry", () => {
  afterEach(() => {
    clearScope("tui_reg")
  })

  test("a client without a declaration has no scope (stream is unfiltered)", () => {
    expect(getScope("tui_reg")).toBeUndefined()
  })

  // A subscriber that presented x-opencode-client-id has opted in, so it must be
  // filtered even before its scope POST lands — otherwise it would see foreign
  // project data during the startup gap (§7).
  test("a subscriber with the client-id header but no declaration is fail-closed", () => {
    expect(allowsForClient("tui_pending", live("catalog.updated", undefined, B))).toBe(false)
    expect(allowsForClient("tui_pending", live("session.next.text.delta", "ses_x", B))).toBe(false)
    // Foreign directory AND a session outside the (empty) visible set: dropped
    // even for status frames — that is the whole point of the fail-closed window.
    expect(allowsForClient("tui_pending", live("session.created", "ses_x", B))).toBe(false)
    // Location-less frames carry no project and stay delivered (R2).
    expect(allowsForClient("tui_pending", live("session.created", "ses_x"))).toBe(true)
    expect(allowsForClient("tui_pending", live("project.updated", undefined, "global"))).toBe(true)
    // No header at all = not opted in = untouched (run, ACP, app, control-plane).
    expect(allowsForClient(undefined, live("catalog.updated", undefined, B))).toBe(true)
  })

  test("the visible set includes subagents that appear after declaration", () => {
    installScopeTracking()
    const id = clientID()
    setScope(id, { directory: A, sessions: ["ses_root"] })
    expect(getScope(id)!.sessions.has("ses_root")).toBe(true)
    expect(getScope(id)!.sessions.has("ses_child")).toBe(false)

    GlobalBus.emit("event", {
      directory: A,
      payload: {
        id: "evt",
        type: "session.updated",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
      },
    })
    expect(getScope(id)!.sessions.has("ses_child")).toBe(true)
    clearScope(id)
  })

  test("a child of a foreign session is not added", () => {
    installScopeTracking()
    const id = clientID()
    setScope(id, { directory: A, sessions: ["ses_root"] })
    GlobalBus.emit("event", {
      directory: A,
      payload: {
        id: "evt",
        type: "session.updated",
        properties: { sessionID: "ses_other_child", info: { id: "ses_other_child", parentID: "ses_other" } },
      },
    })
    expect(getScope(id)!.sessions.has("ses_other_child")).toBe(false)
    clearScope(id)
  })
})
