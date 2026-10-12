// Debug logging for the plugin. v1 duplicated this helper in every module; it lives in one place here.
// Best effort only: a plugin must never fail because a log line could not be written.

import { appendFileSync } from "node:fs"

const LOG_FILE = `${process.env.HOME || "/home/chief"}/.claude/yesmem/logs/plugin-v2.log`

export function debugLog(tag: string, message: string) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${tag} ${message}\n`)
  } catch {}
}
