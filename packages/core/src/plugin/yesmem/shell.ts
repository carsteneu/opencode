// shell.create.before — hand the yesmem environment to every shell the session spawns.
//
// Ported from the v1 plugin's `shell.env` hook. Subprocesses (including the yesmem MCP server) read
// YESMEM_SOCKET / YESMEM_SOURCE_AGENT / YESMEM_SESSION_ID from here, and the process re-registers itself
// with the daemon on every call so the session → PID mapping survives a daemon restart.

import type { YesMemRPC } from "./rpc"

export interface ShellCreateEvent {
  env?: Record<string, string | undefined>
}

export function shellEnvironment(rpc: YesMemRPC, socketPath: string, currentSession: () => string) {
  async function before(event: ShellCreateEvent) {
    const env = event.env
    if (!env) return

    // The socket the client actually dials, so an override stays consistent for subprocesses too.
    env.YESMEM_SOCKET = socketPath
    env.YESMEM_SOURCE_AGENT = "opencode"

    const sessionID = currentSession()
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
