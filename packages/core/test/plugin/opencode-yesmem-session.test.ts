import { describe, expect, test } from "bun:test"
import { fakeContext, loadPlugin, mockDaemon, withSocket, type DaemonRequest } from "./opencode-yesmem-fixture"

const daemonHandler = (request: DaemonRequest) => {
  if (request.method === "register_pid") return { result: { ok: true } }
  return { result: {} }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for the plugin to react")
}

/** The plugin subscribes to the host stream asynchronously, so publish until it is observed. */
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
  test("exports the yesmem socket and source agent to every shell call", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/shell")
        await loadPlugin(recorder)

        const { event, error } = await recorder.fire("shell.create.before", { env: {} })

        expect(error).toBeUndefined()
        expect(event.env.YESMEM_SOCKET).toBe(daemon.socketPath)
        expect(event.env.YESMEM_SOURCE_AGENT).toBe("opencode")
        // No session yet, so there is nothing to register.
        expect(event.env.YESMEM_SESSION_ID).toBeUndefined()
        expect(daemon.hooked().some((request) => request.method === "register_pid")).toBe(false)
      })
    } finally {
      await daemon.close()
    }
  })

  test("tracks a created session and re-registers the process on each shell call", async () => {
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

          const before = registrations().length
          const { event } = await recorder.fire("shell.create.before", { env: {} })
          expect(event.env.YESMEM_SESSION_ID).toBe("ses_evt")
          await waitFor(() => registrations().length > before)
        } finally {
          await stop()
        }
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
