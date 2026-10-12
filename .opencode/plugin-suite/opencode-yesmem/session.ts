// Session tracking.
//
// v1 tracked sessions through a `session.created` plugin hook and re-registered the process with the daemon
// so it can map a session to the PID that owns it. v2 plugins subscribe to host events instead; the payload
// of `session.created` carries `data.sessionID`.

import type { YesMemRPC } from "./rpc"

export interface HostEvent {
  readonly type?: string
  readonly data?: Record<string, any>
}

export function sessionTracker(rpc: YesMemRPC) {
  let currentSessionID = ""

  async function adopt(sessionID: unknown) {
    if (typeof sessionID !== "string" || !sessionID) return
    currentSessionID = sessionID
    process.env.YESMEM_SESSION_ID = sessionID
    await rpc.call("register_pid", {
      session_id: `opencode:${sessionID}`,
      pid: process.pid,
      source_agent: "opencode",
    })
  }

  return {
    current: () => currentSessionID,
    adopt,
    /** Consumes host events and adopts a session when one starts. */
    async observe(event: HostEvent) {
      if (event?.type !== "session.created") return
      await adopt(event.data?.sessionID)
    },
  }
}
