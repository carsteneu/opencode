// Debug logging for the plugin. v1 duplicated this helper in every module; it lives in one place here.
// Best effort only: a plugin must never fail because a log line could not be written.

import { appendFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

const MAX_LOG_BYTES = 5 * 1024 * 1024
let writes = 0

// YESMEM_LOG_FILE lets tests (and users) keep the plugin's debug output out of the live install.
function logFile() {
  return process.env.YESMEM_LOG_FILE || `${process.env.HOME || homedir()}/.claude/yesmem/logs/plugin-v2.log`
}

export function debugLog(tag: string, message: string) {
  try {
    const file = logFile()
    // The v1 log grew past 100 MB; check the size occasionally instead of on every line.
    if (++writes % 100 === 0 && (statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES)
      writeFileSync(file, "")
    appendFileSync(file, `[${new Date().toISOString()}] ${tag} ${message}\n`, { mode: 0o600 })
  } catch {}
}
