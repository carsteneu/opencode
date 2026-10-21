// shell.create.before — hand the yesmem environment to every shell the session spawns.
//
// Ported from the v1 plugin's `shell.env` hook: subprocesses (including the yesmem MCP server) inherit
// YESMEM_SOCKET and YESMEM_SOURCE_AGENT from here, so they reach the daemon the caller configured.
//
// The host's `ShellCreateBefore` carries no session id (checked in the fork's
// packages/plugin/src/effect/shell.ts), while one `opencode serve --service` process hosts every session.
// A shell therefore cannot be attributed to the session that spawned it, and the id of the last-created
// session is never a substitute (YM-257): without it the daemon resolves the caller from the shell's
// working directory. An id is forwarded and registered only when a host supplies it with the event.

import type { YesMemRPC } from "./rpc"

export interface ShellCreateEvent {
  env?: Record<string, string | undefined>
  /** Present on hosts that pass the spawning session through (not yet the case in opencode v2). */
  sessionID?: string
}

export function shellEnvironment(rpc: YesMemRPC, socketPath: string) {
  async function before(event: ShellCreateEvent) {
    const env = event.env
    if (!env) return

    // The socket the client actually dials, so an override stays consistent for subprocesses too.
    env.YESMEM_SOCKET = socketPath
    env.YESMEM_SOURCE_AGENT = "opencode"

    // The host hands over a copy of its own environment, so an id the service process inherited (say,
    // `opencode serve` started from a yesmem-managed shell) would travel unchanged into every shell. An id
    // that this shell's session did not supply must not reach any child (YM-257).
    delete env.YESMEM_SESSION_ID

    // Only an id the host attributes to this shell may travel with it. The daemon registers the service
    // PID, which identifies no session, so a guessed id would be worse than none.
    const sessionID = typeof event.sessionID === "string" ? event.sessionID.trim() : ""
    if (!sessionID) return
    env.YESMEM_SESSION_ID = sessionID

    await rpc.call("register_pid", {
      session_id: `opencode:${sessionID}`,
      pid: process.pid,
      source_agent: "opencode",
    })
  }

  return { before }
}
