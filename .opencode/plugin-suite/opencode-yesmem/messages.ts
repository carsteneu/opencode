// Message helpers shared by the message-level nudges (v1 duplicated these in two modules).
//
// Cache-safety doctrine (yesmem learnings #81269/#85490): a per-turn injection may only patch the TERMINAL
// user message — the mutable tail of the request. Rewriting anything earlier desyncs the prompt cache.

export interface HostTextPart {
  type?: string
  text?: string
}

export interface HostMessage {
  id?: string
  role?: string
  content?: HostTextPart[]
}

export function textParts(message: HostMessage | undefined): HostTextPart[] {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
}

/**
 * The last genuine user turn that carries text; assistant and tool messages are skipped, and a user message
 * without text does not count as the terminal turn.
 */
export function findTerminalUserText(messages: ReadonlyArray<HostMessage> | undefined) {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    const part = textParts(message)[0]
    if (part?.text) return { text: part.text, part, message }
  }
  return undefined
}

/** User turns that carry text; the idle reminder counts its cadence from these. */
export function countUserTurns(messages: ReadonlyArray<HostMessage> | undefined): number {
  if (!Array.isArray(messages)) return 0
  let turns = 0
  for (const message of messages) if (message?.role === "user" && textParts(message).length > 0) turns++
  return turns
}

export function hashString(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}
