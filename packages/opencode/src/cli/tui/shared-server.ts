import { pidAlive, probeHealth, readLock, removeLock, type Lock } from "@/server/shared/lock"

const DEFAULT_TIMEOUT_MS = 10_000
const POLL_MS = 100

export type SharedTarget = { readonly url: string; readonly password: string }

/**
 * Finds a running global shared server, or starts a detached one and waits for
 * it to publish a healthy lock. Returns undefined when neither succeeds — the
 * caller then falls back to today's private IPC server, so a broken discovery
 * is never worse than the status quo.
 */
export async function findOrStartSharedServer(
  options: { timeoutMs?: number } = {},
): Promise<SharedTarget | undefined> {
  const existing = readLock()
  if (existing) {
    if (!pidAlive(existing.pid)) {
      // Dead owner — stale record, safe to drop.
      removeLock()
    } else {
      const health = await probeHealth(existing.url, existing.password)
      if (health && health.version === existing.version) return target(existing)
      // Live pid, no healthy answer: it may be the peer we are about to race
      // with. Do not remove its lock or kill anything; just proceed to start
      // our own detached server and let the lock race decide.
    }
  }

  spawnSharedServer()

  const lock = await awaitHealthyLock(Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  return lock ? target(lock) : undefined
}

function target(lock: Lock): SharedTarget {
  return { url: lock.url, password: lock.password }
}

async function awaitHealthyLock(deadline: number): Promise<Lock | undefined> {
  while (Date.now() < deadline) {
    const lock = readLock()
    if (lock) {
      const health = await probeHealth(lock.url, lock.password)
      if (health && health.version === lock.version) return lock
    }
    await Bun.sleep(POLL_MS)
  }
  return undefined
}

function spawnSharedServer() {
  const developmentEntry = process.argv[1]?.match(/\.[cm]?[jt]s$/) ? process.argv[1] : undefined
  const password = Bun.randomUUIDv7()
  // Carry global flags that change what the server loads, so `opencode --pure`
  // does not quietly start a plugin-loading server.
  const passthrough = process.argv.includes("--pure") ? ["--pure"] : []
  const child = Bun.spawn(
    [process.execPath, ...(developmentEntry ? [developmentEntry] : []), "serve", "--shared", ...passthrough],
    {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_JSC_forceRAMSize")),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SHARED_SERVER: "1",
      OPENCODE_LLM_POOL_MAX: "6",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: process.env.OPENCODE_SHARED_SERVER_DEBUG ? "inherit" : "ignore",
  })
  child.unref()
}

export * as SharedServerClient from "./shared-server"
