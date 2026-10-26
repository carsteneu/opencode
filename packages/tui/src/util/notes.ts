import type { LocationPublicRef, SessionMessageInfo } from "@opencode/client"

/** Answers are stored in the same file as the notes, so they get a ceiling. */
export const NOTE_ANSWER_LIMIT = 4000

export type NoteAnswer = {
  text: string
  messageID: string
  time: number
  /** True when the stored text is the capped prefix of a longer answer. */
  truncated?: boolean
}

export type NoteState = "open" | "sent" | "answered"

export type Note = {
  id: string
  text: string
  done: boolean
  created: number
  updated: number
  state: NoteState
  sentAt?: number
  /** The user message this note's last send produced; the answer is looked up from it. */
  sentID?: string
  /** Project attribution captured at creation; nothing groups by it yet. */
  projectID?: string
  location?: LocationPublicRef
  answer?: NoteAnswer
}

export type NotesState = { notes: Record<string, Note[]> }

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>
type AssistantPart = AssistantMessage["content"][number]
type TextPart = Extract<AssistantPart, { type: "text" }>

// The note map is keyed by session id, so a "__proto__" key would shadow the notes record's own
// prototype instead of adding an entry. Session ids are server-made, but the guard is what keeps a
// malformed one from silently replacing the map's prototype.
function ownKey(sessionID: string) {
  if (sessionID === "__proto__" || sessionID === "constructor" || sessionID === "prototype") return
  return sessionID
}

function isNote(value: unknown): value is Note {
  return typeof value === "object" && value !== null
}

/** The live array for a session (mutate through it), or an empty throwaway. */
function list(state: NotesState, sessionID: string) {
  if (ownKey(sessionID) === undefined) return [] as Note[]
  const notes: unknown = state.notes
  if (typeof notes !== "object" || notes === null) return [] as Note[]
  // Reading the property is what subscribes the caller to the first note of a session; a guard based
  // on Object.hasOwn would return an empty list without ever touching the key, and the sidebar would
  // not re-render when that session's first note arrives.
  const value = (notes as Record<string, unknown>)[sessionID]
  return Array.isArray(value) ? (value as Note[]) : ([] as Note[])
}

function find(state: NotesState, sessionID: string, id: string) {
  return list(state, sessionID).find((note) => note.id === id)
}

/** Unchecked notes by creation, checked-off ones last. */
export function notesOf(state: NotesState, sessionID: string) {
  return list(state, sessionID)
    .filter(isNote)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.created - b.created)
}

// The history dialog reads as an answer archive: answered first, then sent, then open, and a note
// checked off by hand last. Sending checks a note off, so `done` alone cannot order it.
function rank(note: Note) {
  if (note.state === "answered") return 0
  if (note.state === "sent") return 1
  return note.done ? 3 : 2
}

/** The same notes, ordered for the history dialog, newest activity first within each state. */
export function historyNotes(state: NotesState, sessionID: string) {
  return list(state, sessionID)
    .filter(isNote)
    .sort((a, b) => rank(a) - rank(b) || (b.sentAt ?? b.created) - (a.sentAt ?? a.created))
}

export function addNote(
  state: NotesState,
  sessionID: string,
  input: {
    text: string
    now?: number
    id?: string
    projectID?: string
    location?: LocationPublicRef
  },
): Note | undefined {
  const key = ownKey(sessionID)
  if (key === undefined) return
  const text = input.text.trim()
  if (!text) return
  const at = input.now ?? Date.now()
  const note: Note = {
    id: input.id ?? crypto.randomUUID(),
    text,
    done: false,
    created: at,
    updated: at,
    state: "open",
  }
  if (input.projectID !== undefined) note.projectID = input.projectID
  if (input.location !== undefined) note.location = { directory: input.location.directory }
  state.notes[key] = [...list(state, sessionID), note]
  return note
}

export function toggleNote(state: NotesState, sessionID: string, id: string, now = Date.now()) {
  const note = find(state, sessionID, id)
  if (!note) return
  note.done = !note.done
  note.updated = now
}

export function setNoteText(state: NotesState, sessionID: string, id: string, text: string, now = Date.now()) {
  const note = find(state, sessionID, id)
  const next = text.trim()
  // An edit to nothing would erase the note the user was editing; deleting is its own action.
  if (!note || !next) return
  note.text = next
  note.updated = now
}

export function deleteNote(state: NotesState, sessionID: string, id: string) {
  const notes = list(state, sessionID)
  const index = notes.findIndex((note) => note.id === id)
  if (index < 0) return
  state.notes[ownKey(sessionID)!] = notes.filter((note) => note.id !== id)
}

/**
 * Drops the clutter only: checked-off notes that never produced an answer. Sent notes still wait for
 * theirs, and captured answers are the archive the notes exist for, so neither is touched.
 */
export function clearDone(state: NotesState, sessionID: string) {
  const notes = list(state, sessionID)
  const remaining = notes.filter((note) => !note.done || note.answer !== undefined || note.state !== "open")
  if (remaining.length === notes.length) return false
  state.notes[ownKey(sessionID)!] = remaining
  return true
}

/**
 * Records a send that really happened. A re-send starts a fresh wait: the previous answer belongs to
 * the turn the earlier send caused, and keeping it would leave the note looking answered forever.
 */
export function markSent(state: NotesState, sessionID: string, id: string, sentID: string, at: number) {
  const note = find(state, sessionID, id)
  if (!note) return
  note.state = "sent"
  note.sentID = sentID
  note.sentAt = at
  note.done = true
  note.updated = at
  note.answer = undefined
}

function capped(text: string, messageID: string, time: number): NoteAnswer {
  if (text.length <= NOTE_ANSWER_LIMIT) return { text, messageID, time }
  const cut = text.slice(0, NOTE_ANSWER_LIMIT)
  // slice() counts UTF-16 units: a pair on the boundary would leave a lone surrogate in the stored
  // JSON, which renders as a replacement character.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  return { text: whole, messageID, time, truncated: true }
}

/**
 * The answer is the first completed assistant message after the note's own user message that carries
 * text and no tool call: an intermediate step ("let me look at the file") is not the answer, and a
 * turn that errored produced none.
 */
function answerAfter(messages: readonly SessionMessageInfo[], start: number) {
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    if (message.time.completed === undefined) continue
    if (message.error !== undefined || message.finish === "error") continue
    if (message.content.some((part) => part.type === "tool")) continue
    if (!message.content.some((part) => part.type === "text")) continue
    return message
  }
  return
}

/**
 * Matches sent notes to the answers they caused. Each note is anchored on the user message its send
 * produced, so the match does not depend on wall-clock agreement between client and server, on when
 * the send's state write landed, or on the note text staying unchanged.
 */
export function pendingAnswers(
  notes: readonly Note[],
  messages: readonly SessionMessageInfo[],
): Map<string, NoteAnswer> {
  const result = new Map<string, NoteAnswer>()
  const waiting = notes
    .filter(isNote)
    .filter((note) => note.state === "sent" && !note.answer && note.sentID !== undefined)
    .sort((a, b) => (a.sentAt ?? a.updated) - (b.sentAt ?? b.updated))
  if (waiting.length === 0) return result

  const claimed = new Set(notes.filter(isNote).flatMap((note) => (note.answer ? [note.answer.messageID] : [])))
  for (const note of waiting) {
    const start = messages.findIndex((message) => message.type === "user" && message.id === note.sentID)
    // The echo of the note's own message has not arrived yet; the next completed message retries.
    if (start < 0) continue
    const match = answerAfter(messages, start + 1)
    if (!match || claimed.has(match.id)) continue
    // Reasoning and tool output stay out of the note: the note mirrors what was asked and shown,
    // not the machinery that produced it.
    const text = match.content
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n")
    if (!text) continue
    claimed.add(match.id)
    result.set(note.id, capped(text, match.id, match.time.completed!))
  }
  return result
}

/** Stores the matched answers. Returns whether the draft changed. */
export function captureAnswers(state: NotesState, sessionID: string, messages: readonly SessionMessageInfo[]) {
  const notes = list(state, sessionID)
  const answers = pendingAnswers(notes, messages)
  if (answers.size === 0) return false
  for (const note of notes.filter(isNote)) {
    const answer = answers.get(note.id)
    if (!answer) continue
    note.answer = answer
    note.state = "answered"
  }
  return true
}
