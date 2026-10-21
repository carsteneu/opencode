// Session tracking.
//
// v1 tracked sessions through a `session.created` plugin hook and re-registered the process with the daemon
// so it can map a session to the PID that owns it. v2 plugins subscribe to host events instead; the payload
// of `session.created` carries `data.sessionID`.
//
// One `opencode serve --service` process hosts every session, so the plugin must not publish the id of the
// session it saw last into shared state: that state belongs to no session in particular, and every
// `yesmem mcp` child would inherit it (YM-257). Tool calls carry their own `event.sessionID`.

import type { YesMemRPC } from "./rpc"

export interface HostEvent {
  readonly type?: string
  readonly data?: Record<string, any>
}

export function sessionTracker(rpc: YesMemRPC) {
  async function adopt(sessionID: unknown) {
    if (typeof sessionID !== "string" || !sessionID) return
    // Still registered on purpose: the daemon persists `source_agent:<session>` from this call, and the
    // briefing wording depends on it (internal/briefing/generate_full.go). The PID it records is the shared
    // service's, which identifies no session, so nothing may be resolved *from* this registration alone.
    await rpc.call("register_pid", {
      session_id: `opencode:${sessionID}`,
      pid: process.pid,
      source_agent: "opencode",
    })
  }

  return {
    adopt,
    /** Consumes host events and adopts a session when one starts. */
    async observe(event: HostEvent) {
      if (event?.type !== "session.created") return
      await adopt(event.data?.sessionID)
    },
  }
}
