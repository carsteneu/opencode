// Message helpers shared by the message-level nudges (v1 duplicated these in two modules).
//
// Cache-safety doctrine (yesmem learnings #81269/#85490): a per-turn injection may only patch the TERMINAL
// human message — the mutable tail of the request. Rewriting anything earlier desyncs the prompt cache.
//
// Telling a human turn apart from history is not just `role === "user"`: v2 lowers several history entries to
// user-role messages (packages/core/src/session/runner/to-llm-message.ts). Every non-human case is pinned to
// the code that produces it, not guessed:
//
//   shell result       text opens with "The following shell command was executed by the user:"  (to-llm-message)
//   compaction         text opens with "<conversation-checkpoint>"                              (to-llm-message)
//   location switch    text opens with "The working directory has been changed to "             (to-llm-message)
//   inlined skill      text opens with "<skill_content name=…"                                  (Skill.toModelOutput)
//   synthetic          built without metadata at all                                            (to-llm-message)
//   skill activation   reuses the ID of the user message that triggered it                     (see below)
//
// The ID rule: `Session.skill` publishes its event with `id: messageID.replace(/^msg_/, "evt_")` and
// `SessionMessage.ID.fromEvent` maps that back to `msg_…` (packages/schema/src/session-message.ts:28), so the
// appended skill message carries the SAME id as the human message it belongs to. A repeated id is therefore a
// derived message, never a second human turn — and it keeps the patch target on the human message.
//
// Known limit: a user-role message that carries metadata, a fresh id AND a bare SKILL.md body cannot be told
// apart from a human message with the information the hook exposes. No core path produces one today (the
// standalone skill message has no metadata: bus.ts only sets it when the publisher passes it, and
// Session.skill passes only the id).

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
  "<skill_content",
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
 * The part an injection should extend: the last text part that has content, because that is the closest to
 * the request tail and changing it invalidates the fewest cached tokens.
 */
export function patchTarget(message: HostMessage | undefined): HostTextPart | undefined {
  const parts = textParts(message)
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].text) return parts[i]
  return undefined
}

/** Shape-only check; id-derived messages are ruled out by `humanUserMessages`. */
export function isHumanUserMessage(message: HostMessage | undefined): boolean {
  if (message?.role !== "user") return false
  // Synthetic messages are built without metadata (to-llm-message.ts); every other user-role message has it.
  if (message.metadata === undefined) return false
  const text = messageText(message).trimStart()
  return !NON_HUMAN_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/** The human turns of a request, in order, with derived (id-reusing) messages dropped. */
export function humanUserMessages(messages: ReadonlyArray<HostMessage> | undefined): HostMessage[] {
  if (!Array.isArray(messages)) return []
  const seen = new Set<string>()
  const humans: HostMessage[] = []
  for (const message of messages) {
    if (typeof message?.id === "string" && message.id) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
    }
    if (isHumanUserMessage(message)) humans.push(message)
  }
  return humans
}

export interface TerminalUserText {
  /** Full text of the human message, for matching. */
  text: string
  /** The part the nudge is injected into. */
  part: HostTextPart
  message: HostMessage
}

/** The last message the human actually wrote; undefined when it carries no text to patch. */
export function findTerminalUserText(messages: ReadonlyArray<HostMessage> | undefined): TerminalUserText | undefined {
  const humans = humanUserMessages(messages)
  const message = humans[humans.length - 1]
  if (!message) return undefined
  const part = patchTarget(message)
  if (!part?.text) return undefined
  return { text: messageText(message), part, message }
}

/** Human turns in the request; the idle reminder counts its cadence from these. */
export function countUserTurns(messages: ReadonlyArray<HostMessage> | undefined): number {
  return humanUserMessages(messages).length
}

export function hashString(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}
