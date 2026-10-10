import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { activeSseCount } from "@/server/routes/instance/httpapi/sse-counters"
import { writeLock, removeLockIfOwned, type Lock } from "./lock"

// A shared server outlives the window that started it, so the old
// "IPC disconnect => stop" rule cannot apply. Liveness is instead a function of
// how many clients are attached: open /global/event streams are the counter.
export const GRACE_MS = 30_000
const POLL_MS = 5_000

export type InstallOptions = {
  readonly url: string
  readonly password: string
  readonly onIdle: () => void | Promise<void>
  readonly graceMs?: number
  readonly pollMs?: number
  readonly now?: () => number
  readonly active?: () => number
}

export type InstallResult = { readonly owned: boolean }

/**
 * Publishes the discovery lock and, once the last client has been gone for the
 * grace period, tears the process down via `onIdle`. Returns `owned: false` when
 * a healthy peer already owns the lock — the caller then exits so the window
 * discovers the winner instead.
 */
export async function installSharedLifecycle(options: InstallOptions): Promise<InstallResult> {
  const lock: Lock = {
    pid: process.pid,
    url: options.url,
    password: options.password,
    version: InstallationVersion,
    startedAt: new Date().toISOString(),
  }
  if (!(await writeLock(lock))) return { owned: false }

  const now = options.now ?? Date.now
  const active = options.active ?? activeSseCount
  const graceMs = options.graceMs ?? GRACE_MS
  const pollMs = options.pollMs ?? POLL_MS

  let lastActive = now()
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    if (active() > 0) {
      lastActive = now()
      return
    }
    if (now() - lastActive < graceMs) return
    stopped = true
    clearInterval(timer)
    removeLockIfOwned()
    void Promise.resolve(options.onIdle()).catch(() => process.exit(1))
  }, pollMs)
  timer.unref?.()

  return { owned: true }
}

export * as SharedLifecycle from "./lifecycle"
