// Debug logging for the plugin. v1 duplicated this helper in every module; it lives in one place here.
// Best effort only: a plugin must never fail because a log line could not be written.

import { appendFileSync } from "node:fs"
import { homedir } from "node:os"

// YESMEM_LOG_FILE lets tests (and users) keep the plugin's debug output out of the live install.
function logFile() {
  return process.env.YESMEM_LOG_FILE || `${process.env.HOME || homedir()}/.claude/yesmem/logs/plugin-v2.log`
}

export function debugLog(tag: string, message: string) {
  try {
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${tag} ${message}\n`, { mode: 0o600 })
  } catch {}
}
