import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { allows, clearScope, getScope, installScopeTracking, setScope, type Scope } from "../../src/server/shared/scope"

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

  test("R4: session status/list stays project-wide", () => {
    const own = scope(A, ["ses_a"])
    for (const type of ["session.created", "session.updated", "session.deleted", "session.status", "session.idle"]) {
      expect(allows(live(type, "ses_b", A), own)).toBe(true)
      expect(allows(sync(type, `${type}.1`, "ses_b", B), own)).toBe(true)
    }
  })

  test("unknown events are delivered (in doubt, deliver)", () => {
    const own = scope(A, [])
    expect(allows(live("some.future.event", undefined, B), own)).toBe(true)
    expect(allows({ directory: B, payload: { id: "x", type: "brand.new", properties: {} } }, own)).toBe(true)
  })

  test("plugin.added and vcs.branch.updated stay delivered", () => {
    const own = scope(A, [])
    expect(allows(live("plugin.added", undefined, B), own)).toBe(true)
    expect(allows(live("vcs.branch.updated", undefined, B), own)).toBe(true)
  })
})

describe("event scope registry", () => {
  afterEach(() => {
    clearScope("tui_reg")
  })

  test("a client without a declaration has no scope (stream is unfiltered)", () => {
    expect(getScope("tui_reg")).toBeUndefined()
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
