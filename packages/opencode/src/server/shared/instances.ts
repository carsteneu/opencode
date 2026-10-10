// Per-directory client refcount plus idle unloading of that directory's instance.
//
// A shared server holds one instance per project directory: file watchers, LSP
// processes, MCP servers and the resolved project state. Nothing drops them while
// the server lives, so the resident set grows with every project you ever open and
// stays there after its windows are gone — which cancels exactly the memory the
// shared server exists to save.
//
// A directory's instance is therefore released once no client holds it any more.
// The release is delayed by a grace period so reopening a window right after
// closing it does not pay an instance reload.
//
// This module owns only the bookkeeping: it is framework-free and takes the
// current time as an argument, so the decision is testable without timers. The
// caller that owns the store runs the unload (see server/shared/unload.ts).

const DEFAULT_GRACE_MS = 60_000

// Scope-declaring clients per directory, and when each unheld directory went idle.
const clients = new Map<string, number>()
const idleSince = new Map<string, number>()

/** `0` disables unloading entirely; unset falls back to the default grace. */
export function graceMsFromEnv(): number {
  const raw = process.env.OPENCODE_SHARED_SERVER_INSTANCE_IDLE_MS
  if (raw === undefined || raw.trim() === "") return DEFAULT_GRACE_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_MS
}

export function retain(directory: string) {
  if (!directory) return
  clients.set(directory, (clients.get(directory) ?? 0) + 1)
  idleSince.delete(directory)
}

export function release(directory: string, at: number = Date.now()) {
  if (!directory) return
  const remaining = (clients.get(directory) ?? 0) - 1
  if (remaining > 0) {
    clients.set(directory, remaining)
    return
  }
  clients.delete(directory)
  if (!idleSince.has(directory)) idleSince.set(directory, at)
}

/**
 * Directories whose grace elapsed. Claimed, so a caller that is slow to dispose
 * (or fails) does not retry on every tick — the next `retain` restarts tracking.
 */
export function claimIdle(graceMs: number, at: number = Date.now()): string[] {
  if (graceMs <= 0) return []
  const claimed: string[] = []
  for (const [directory, since] of idleSince) {
    if (at - since < graceMs) continue
    idleSince.delete(directory)
    claimed.push(directory)
  }
  return claimed
}

export function instanceTracking() {
  return { attached: Object.fromEntries(clients), idle: Object.fromEntries(idleSince) }
}

export function resetInstanceTracking() {
  clients.clear()
  idleSince.clear()
}

export * as SharedInstances from "./instances"
