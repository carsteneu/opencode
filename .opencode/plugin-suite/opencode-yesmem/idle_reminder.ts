// idle_reminder — invisible yesmem usage reminder, every Nth real user turn.
//
// Ported from the v1 plugin's idle_reminder.ts: the reminder is patched into the terminal user message, so
// the model sees it and the TUI shows nothing. Deterministic and stateless — the cadence is counted from the
// request's own message array.
//
// Disable entirely with YESMEM_IDLE=off; cadence via YESMEM_IDLE_CADENCE (floor 2).

import { debugLog } from "./log"
import { countUserTurns, findTerminalUserText, type HostMessage } from "./messages"

const REMINDER_SIG = "[yesmem-idle]"
const FALLBACK =
  "Du hast ein Langzeitgedaechtnis (yesmem). Bei nicht-trivialen Aufgaben: ZUERST search(thema)."

// v2 has no `synthetic` flag on parts (v1 excluded synthetic-only user messages); the environment context
// lives in the request's system parts, so counting user messages with text is the equivalent.
function cadence(): number {
  return Math.max(2, Number(process.env.YESMEM_IDLE_CADENCE || 3))
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
    // Some loops resend the patched message; never append twice.
    if (hit.text.includes(REMINDER_SIG)) return

    hit.part.text = `${hit.text}\n\n${REMINDER_SIG} ${FALLBACK}`
    debugLog("idle_reminder", `patched invisible reminder at user-turn ${turns}`)
  }

  return { context }
}
