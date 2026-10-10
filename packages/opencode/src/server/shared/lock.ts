import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"

// Discovery record for the global shared server. One file per binary version so
// an upgrade never contends with a running older server: the new version finds
// no lock for itself, starts its own, and the old one dies with its last client.
export type Lock = {
  readonly pid: number
  readonly url: string
  readonly password: string
  readonly version: string
  readonly startedAt: string
}

export const HEALTH_TIMEOUT_MS = 300

// Resolved per call from the environment (mirrors how the TUI server child
// locates its log dir) so the path tracks XDG_DATA_HOME and is test-isolatable.
export function serversDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "servers")
}

export function lockPath(version: string = InstallationVersion) {
  return path.join(serversDir(), `${version}.json`)
}

function parse(raw: unknown): Lock | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined
  if (typeof value.url !== "string" || value.url === "") return undefined
  return {
    pid: value.pid as number,
    url: value.url,
    password: typeof value.password === "string" ? value.password : "",
    version: typeof value.version === "string" ? value.version : InstallationVersion,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  }
}

export function readLock(version: string = InstallationVersion): Lock | undefined {
  try {
    return parse(JSON.parse(fs.readFileSync(lockPath(version), "utf8")))
  } catch {
    return undefined
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function authHeader(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

export async function probeHealth(
  url: string,
  password: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{ healthy: true; version: string } | undefined> {
  try {
    const response = await fetch(new URL("/global/health", url), {
      headers: password ? { Authorization: authHeader(password) } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { healthy?: unknown; version?: unknown }
    if (body?.healthy !== true || typeof body.version !== "string") return undefined
    return { healthy: true, version: body.version }
  } catch {
    return undefined
  }
}

export function removeLock(version: string = InstallationVersion) {
  try {
    fs.rmSync(lockPath(version), { force: true })
  } catch {}
}

export function removeLockIfOwned(version: string = InstallationVersion) {
  const existing = readLock(version)
  if (existing && existing.pid === process.pid) removeLock(version)
}

/**
 * Atomically and exclusively publishes a lock. Writes a fully-formed temp file
 * then hard-links it into place: the link is atomic, so readers never observe a
 * half-written file, and EEXIST tells us a peer won the race.
 *
 * Returns false when a live peer already owns the lock — the caller then has no
 * role and exits, and the window discovers the winner. A lock whose pid is dead
 * is a crash orphan and is reclaimed. A live-but-unreachable pid is deliberately
 * NOT stolen: that window falls back to its private IPC server instead, so a
 * wedged lock is never worse than the status quo.
 */
export async function writeLock(lock: Lock): Promise<boolean> {
  const file = lockPath(lock.version)
  fs.mkdirSync(serversDir(), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 })
    try {
      fs.linkSync(tmp, file)
      fs.rmSync(tmp, { force: true })
      return true
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const existing = readLock(lock.version)
      if (existing && pidAlive(existing.pid)) return false
      try {
        fs.rmSync(file, { force: true })
      } catch {}
    }
  }
  return false
}

export * as SharedLock from "./lock"
