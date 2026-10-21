// Debug logging for the plugin. v1 duplicated this helper in every module; it lives in one place here.
// Best effort only: a plugin must never fail because a log line could not be written.

import { appendFileSync, renameSync, statSync } from "node:fs"
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
    // The log receives model output: a newline (or a bare CR) in a value would forge a second entry.
    const line = `${tag} ${String(message)}`.replace(/[\r\n]+/g, "\\n")
    // The v1 log grew past 100 MB; check the size occasionally instead of on every line. The file is
    // renamed instead of truncated: several plugin processes append to it, and a truncate in place would
    // drop their lines and reset what a running `tail -f` shows.
    if (++writes % 100 === 0 && (statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
      try {
        renameSync(file, `${file}.1`)
      } catch {}
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 })
  } catch {}
}
