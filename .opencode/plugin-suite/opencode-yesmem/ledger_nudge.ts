// ledger_nudge — live ledger for the active plan.
//
// Appends the thread-scoped active plan as a compact ledger block to the terminal user message, once per
// distinct user message (v1: ledger_nudge.ts). Cache-safety: only the mutable tail is patched, and a
// mid-turn set_plan/update_plan does not change the already-injected ledger (plan-version-freeze) — the new
// state arrives with the next distinct user message.
//
// v2 adaptation: the thread id comes from the hook's own sessionID instead of a process-global "current
// session", and the RPC keeps its 2 s budget so a slow daemon never stalls the first model call.
//
// Disable entirely with YESMEM_LEDGER=off.

import { debugLog } from "./log"
import { findTerminalUserText, hashString, type HostMessage } from "./messages"
import type { YesMemRPC } from "./rpc"

const MAX_LEDGER_LINES = 40
const HEADER = "[yesmem-ledger v1]"
const FOOTER = "[/yesmem-ledger]"

export interface ContextEvent {
  readonly sessionID?: string
  messages?: HostMessage[]
}

/** Renders the ledger block from the active plan (pass-through, bounded). Null when there is nothing to show. */
export function renderLedger(plan: string): string | null {
  if (!plan || !plan.trim()) return null
  const lines = plan.split("\n")
  const truncated = lines.length > MAX_LEDGER_LINES
  const body = (truncated ? lines.slice(0, MAX_LEDGER_LINES) : lines).map((line) => `  ${line}`).join("\n")
  const hint = truncated ? `\n  … (ledger truncated, ${lines.length - MAX_LEDGER_LINES} more lines)` : ""
  return `${HEADER}\n${body}${hint}\n${FOOTER}`
}

export function ledgerNudge(rpc: YesMemRPC) {
  let lastPatchedKey = ""

  async function context(event: ContextEvent) {
    try {
      if (process.env.YESMEM_LEDGER === "off") return

      const messages = event.messages
      if (!messages || messages.length === 0) return

      const hit = findTerminalUserText(messages)
      if (!hit) return

      // Patch once per distinct user message: the message identity keeps two turns with identical text apart.
      const key = hit.message.id ? `id:${hit.message.id}` : hashString(hit.text)
      if (key === lastPatchedKey) return
      if (hit.text.includes(HEADER)) {
        lastPatchedKey = key
        return
      }

      const threadID = event.sessionID ? `opencode:${event.sessionID}` : ""
      if (!threadID) return

      const response = await rpc.call("get_plan", { thread_id: threadID }, { timeoutMs: 2000 })
      if (!response.ok || !response.result) {
        debugLog("ledger", `get_plan skip: ${response.error || "empty"}`)
        lastPatchedKey = key // do not retry this message on every dispatch
        return
      }
      const plan = response.result
      if (!plan.exists || plan.status !== "active") {
        lastPatchedKey = key
        return
      }
      const ledger = renderLedger(typeof plan.plan === "string" ? plan.plan : "")
      if (!ledger) {
        lastPatchedKey = key
        return
      }

      hit.part.text = `${hit.text}\n\n${ledger}`
      lastPatchedKey = key
      debugLog("ledger", `APPENDED ledger (${ledger.length} chars)`)
    } catch (error: any) {
      debugLog("ledger", `ERR: ${error?.message || String(error)}`)
    }
  }

  return { context }
}
