// ledger_nudge — live ledger for the active plan.
//
// Appends the thread-scoped active plan as a compact ledger block to the terminal user message
// (v1: ledger_nudge.ts). Cache-safety: only the terminal human message is patched, the fetched plan is
// cached per user message so every step of a turn injects identical bytes, and a mid-turn
// set_plan/update_plan does not change the already-injected ledger (plan-version-freeze) — the new state
// arrives with the next user message.
//
// v2 adaptation: the thread id comes from the hook's own sessionID instead of a process-global "current
// session", and the RPC keeps a short budget so an unresponsive daemon delays the first model call of a turn
// by at most that budget.
//
// Disable entirely with YESMEM_LEDGER=off.

import { debugLog } from "./log"
import { findTerminalUserText, hashString, type HostMessage } from "./messages"
import type { YesMemRPC } from "./rpc"

const MAX_LEDGER_LINES = 40
const MAX_LEDGER_CHARS = 4000
const LEDGER_CACHE_TTL_MS = 120_000
const PLAN_FETCH_TIMEOUT_MS = 1000
const HEADER = "[yesmem-ledger v1]"
const FOOTER = "[/yesmem-ledger]"

export interface ContextEvent {
  readonly sessionID?: string
  messages?: HostMessage[]
}

/**
 * Plan text reaches the model inside the user's message and is written by a model, so it is untrusted here:
 * control characters and separators that render as line breaks are removed (parity with the code_nav strip,
 * plus the Unicode line/paragraph separators and bidi overrides), and the block delimiters are neutralized
 * case-insensitively — otherwise a plan could close the block and open a trusted-looking instruction.
 */
function sanitizeLine(line: string): string {
  return line
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\[\/?yesmem-ledger[^\]]*\]/gi, "(ledger)")
}

/** Renders the ledger block from the active plan (sanitized and bounded). Null when there is nothing to show. */
export function renderLedger(plan: string): string | null {
  if (!plan || !plan.trim()) return null
  const lines = plan.split("\n")
  const truncated = lines.length > MAX_LEDGER_LINES
  const body = (truncated ? lines.slice(0, MAX_LEDGER_LINES) : lines)
    .map((line) => `  ${sanitizeLine(line)}`)
    .join("\n")
    .substring(0, MAX_LEDGER_CHARS)
  const hint = truncated ? `\n  … (ledger truncated, ${lines.length - MAX_LEDGER_LINES} more lines)` : ""
  return `${HEADER}\n${body}${hint}\n${FOOTER}`
}

export function ledgerNudge(rpc: YesMemRPC) {
  let cachedKey = ""
  let cachedLedger: string | null = null
  let cachedTs = 0

  async function fetchLedger(threadID: string): Promise<string | null> {
    const response = await rpc.call("get_plan", { thread_id: threadID }, { timeoutMs: PLAN_FETCH_TIMEOUT_MS })
    if (!response.ok || !response.result) {
      debugLog("ledger", `get_plan skip: ${response.error || "empty"}`)
      return null
    }
    const plan = response.result
    if (!plan.exists || plan.status !== "active") return null
    return renderLedger(typeof plan.plan === "string" ? plan.plan : "")
  }

  async function context(event: ContextEvent) {
    try {
      if (process.env.YESMEM_LEDGER === "off") return

      const messages = event.messages
      if (!messages || messages.length === 0) return

      const hit = findTerminalUserText(messages)
      if (!hit) return
      // A repeated dispatch of the already patched message needs no work.
      if (hit.text.includes(HEADER)) return

      const threadID = event.sessionID ? `opencode:${event.sessionID}` : ""
      if (!threadID) return

      // The message identity keeps two turns with identical text apart and lets the steps of one turn share
      // the same ledger bytes (the runner rebuilds the request for every step).
      const key = hit.message.id ? `id:${hit.message.id}` : hashString(hit.text)
      const now = Date.now()
      if (key !== cachedKey || now - cachedTs > LEDGER_CACHE_TTL_MS) {
        cachedKey = key
        cachedLedger = await fetchLedger(threadID)
        cachedTs = now
      }
      if (!cachedLedger) return

      hit.part.text = `${hit.part.text ?? ""}\n\n${cachedLedger}`
      debugLog("ledger", `APPENDED ledger (${cachedLedger.length} chars)`)
    } catch (error: any) {
      debugLog("ledger", `ERR: ${error?.message || String(error)}`)
    }
  }

  return { context }
}
