// Message helpers shared by the message-level nudges (v1 duplicated these in two modules).
//
// Cache-safety doctrine (yesmem learnings #81269/#85490): a per-turn injection may only patch the TERMINAL
// user message — the mutable tail of the request. Rewriting anything earlier desyncs the prompt cache.
//
// Telling a human turn apart from history is not just `role === "user"`: v2 lowers several history entries to
// user-role messages (packages/core/src/session/runner/to-llm-message.ts). Each is recognisable by the exact
// frame the core builds it with, so this predicate is derived from that code, not guessed:
//   - shell results      "The following shell command was executed by the user:"
//   - compaction         "<conversation-checkpoint>"
//   - location switch    "The working directory has been changed to "
//   - skill injection    "Base directory for this skill: " (packages/core/src/skill.ts)
//   - synthetic messages carry no metadata at all, while every other user-role message does.

export interface HostTextPart {
  type?: string
  text?: string
}

export interface HostMessage {
  id?: string
  role?: string
  content?: HostTextPart[]
  metadata?: Record<string, unknown>
}

const NON_HUMAN_PREFIXES = [
  "The following shell command was executed by the user:",
  "<conversation-checkpoint>",
  "The working directory has been changed to ",
  "Base directory for this skill:",
]

export function textParts(message: HostMessage | undefined): HostTextPart[] {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
}

/** Everything the model reads in this message; the human text is one part among skill/attachment parts. */
export function messageText(message: HostMessage | undefined): string {
  return textParts(message)
    .map((part) => part.text ?? "")
    .join("\n")
}

/**
 * The part an injection should extend. The last text part is the closest to the request tail, so patching it
 * invalidates the fewest cached tokens.
 */
export function patchTarget(message: HostMessage | undefined): HostTextPart | undefined {
  const parts = textParts(message)
  return parts[parts.length - 1]
}

export function isHumanUserMessage(message: HostMessage | undefined): boolean {
  if (message?.role !== "user") return false
  // Synthetic messages are built without metadata (to-llm-message.ts); every other user-role message has it.
  if (message.metadata === undefined) return false
  const text = messageText(message).trimStart()
  return !NON_HUMAN_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export interface TerminalUserText {
  /** Full text of the human message, for matching. */
  text: string
  /** The part the nudge is injected into. */
  part: HostTextPart
  message: HostMessage
}

/** The last message the human actually wrote, skipping assistant/tool and non-human user-role entries. */
export function findTerminalUserText(messages: ReadonlyArray<HostMessage> | undefined): TerminalUserText | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isHumanUserMessage(message)) continue
    const part = patchTarget(message)
    if (part?.text) return { text: messageText(message), part, message }
  }
  return undefined
}

/** Human turns in the request; the idle reminder counts its cadence from these. */
export function countUserTurns(messages: ReadonlyArray<HostMessage> | undefined): number {
  if (!Array.isArray(messages)) return 0
  let turns = 0
  for (const message of messages) if (isHumanUserMessage(message)) turns++
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
