import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fakeContext, loadPlugin, mockDaemon, withSocket, type DaemonRequest } from "./opencode-yesmem-fixture"

// The test runner itself is spawned from a yesmem-managed shell, so YESMEM_SESSION_ID is in the ambient
// environment. Clear it, otherwise every "must be undefined" assertion reads the inherited value.
let savedSessionID: string | undefined
beforeEach(() => {
  savedSessionID = process.env.YESMEM_SESSION_ID
  delete process.env.YESMEM_SESSION_ID
})
afterEach(() => {
  if (savedSessionID === undefined) delete process.env.YESMEM_SESSION_ID
  else process.env.YESMEM_SESSION_ID = savedSessionID
})

const daemonHandler = (request: DaemonRequest) => {
  if (request.method === "register_pid") return { result: { ok: true } }
  return { result: {} }
}

async function emitUntil(recorder: { emit: (event: any) => void }, event: unknown, predicate: () => boolean) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    recorder.emit(event)
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for the plugin to observe the host event")
}

describe("shell environment", () => {
  test("a shell hook that throws does not fail the shell call", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell4")
        await loadPlugin(recorder)

        // Writing into a frozen env throws in module (strict) code.
        const result = await recorder.fire("shell.create.before", { env: Object.freeze({}) })

        expect(result.failed).toBe(false)
      })
    } finally {
      await daemon.close()
    }
  })

  test("exports the yesmem socket and source agent to every shell call", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell")
        await loadPlugin(recorder)

        const { event, failed } = await recorder.fire("shell.create.before", { env: {} })

        expect(failed).toBe(false)
        expect(event.env.YESMEM_SOCKET).toBe(daemon.socketPath)
        expect(event.env.YESMEM_SOURCE_AGENT).toBe("opencode")
        // The host passes no session id, so there is nothing to forward.
        expect(event.env.YESMEM_SESSION_ID).toBeUndefined()
        expect(daemon.hooked().some((request) => request.method === "register_pid")).toBe(false)
      })
    } finally {
      await daemon.close()
    }
  })

  // YM-257: one `opencode serve --service` process hosts every session. A shell cannot be attributed to
  // the session that spawned it, so the id of the last-created session must never reach a child.
  test("a created session does not leak its id into shells of other sessions", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell2")
        const { stop } = await loadPlugin(recorder, { keepAlive: true })
        try {
          const registrations = () => daemon.hooked().filter((request) => request.method === "register_pid")
          await emitUntil(recorder, { type: "session.created", data: { sessionID: "ses_evt" } }, () =>
            registrations().length > 0,
          )
          expect(registrations()[0]?.params).toEqual({
            session_id: "opencode:ses_evt",
            pid: process.pid,
            source_agent: "opencode",
          })
          // The registration exists for the daemon's source_agent record, not as a lookup for shells.
          expect(process.env.YESMEM_SESSION_ID).toBeUndefined()

          const before = registrations().length
          const { event } = await recorder.fire("shell.create.before", { env: { YESMEM_SESSION_ID: "ses_evt" } })
          expect(event.env.YESMEM_SESSION_ID).toBeUndefined()
          expect(registrations().length).toBe(before)
        } finally {
          await stop()
        }
      })
    } finally {
      await daemon.close()
    }
  })

  test("a shell whose event carries a session id forwards exactly that id", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell5")
        await loadPlugin(recorder)

        const { event, failed } = await recorder.fire("shell.create.before", {
          env: { YESMEM_SESSION_ID: "ses_stale" },
          sessionID: "ses_caller",
        })

        expect(failed).toBe(false)
        expect(event.env.YESMEM_SESSION_ID).toBe("ses_caller")
        const registration = daemon.hooked().find((request) => request.method === "register_pid")
        expect(registration?.params).toEqual({
          session_id: "opencode:ses_caller",
          pid: process.pid,
          source_agent: "opencode",
        })
      })
    } finally {
      await daemon.close()
    }
  })

  test("ignores unrelated host events", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell3")
        const { stop } = await loadPlugin(recorder, { keepAlive: true })
        try {
          recorder.emit({ type: "session.deleted", data: { sessionID: "ses_gone" } })
          recorder.emit({ type: "server.connected", data: {} })
          // Give the subscription a chance to consume both before checking.
          await new Promise((resolve) => setTimeout(resolve, 50))

          const { event } = await recorder.fire("shell.create.before", { env: {} })
          expect(event.env.YESMEM_SESSION_ID).toBeUndefined()
          expect(daemon.hooked().some((request) => request.method === "register_pid")).toBe(false)
        } finally {
          await stop()
        }
      })
    } finally {
      await daemon.close()
    }
  })
})
