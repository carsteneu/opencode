// idle_reminder — invisible yesmem usage reminder, every Nth real user turn.
//
// Ported from the v1 plugin's idle_reminder.ts: the reminder is patched into the terminal user message, so
// the model sees it and the TUI shows nothing. Deterministic and stateless — the cadence is counted from the
// request's own message array, and only messages the human actually wrote count (messages.ts).
//
// Disable entirely with YESMEM_IDLE=off; cadence via YESMEM_IDLE_CADENCE (floor 2).

import { debugLog } from "./log"
import { countUserTurns, findTerminalUserText, type HostMessage } from "./messages"

const REMINDER_SIG = "[yesmem-idle]"
const FALLBACK =
  "Du hast ein Langzeitgedaechtnis (yesmem). Bei nicht-trivialen Aufgaben: ZUERST search(thema)."

function cadence(): number {
  const configured = Number(process.env.YESMEM_IDLE_CADENCE || 3)
  // A non-numeric value yields NaN, which would silently disable the reminder — fall back to the default.
  return Number.isFinite(configured) ? Math.max(2, configured) : 3
}

export interface ContextEvent {
  readonly sessionID?: string
  messages?: HostMessage[]
}

export function idleReminder() {
  async function context(event: ContextEvent) {
    if (process.env.YESMEM_IDLE === "off") return
    const messages = event.messages
    if (!messages || messages.length === 0) return

    const turns = countUserTurns(messages)
    if (turns === 0 || turns % cadence() !== 0) return

    const hit = findTerminalUserText(messages)
    if (!hit) return
    // Every step of a turn presents a fresh copy of the message, so the marker only guards against a
    // repeated dispatch of the same object.
    if (hit.text.includes(REMINDER_SIG)) return

    hit.part.text = `${hit.part.text ?? ""}\n\n${REMINDER_SIG} ${FALLBACK}`
    debugLog("idle_reminder", `patched invisible reminder at user-turn ${turns}`)
  }

  return { context }
}
