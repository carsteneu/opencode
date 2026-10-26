import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  NOTE_ANSWER_LIMIT,
  addNote,
  captureAnswers,
  clearDone,
  deleteNote,
  historyNotes,
  markSent,
  notesOf,
  setNoteText,
  toggleNote,
  type NotesState,
} from "../src/util/notes"

const SESSION = "ses_notes"

function state(): NotesState {
  return { notes: {} }
}

function assistant(
  id: string,
  created: number,
  content: Array<{ type: string; text?: string }>,
  completed: number | null = created + 10,
) {
  return {
    id,
    type: "assistant",
    // null means still streaming: a default parameter cannot express "explicitly absent".
    time: completed === null ? { created } : { created, completed },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    content,
  } as unknown as SessionMessageInfo
}

function user(id: string, created: number) {
  return { id, type: "user", time: { created }, text: "hi" } as unknown as SessionMessageInfo
}

test("a new note starts open, unchecked and stamped", () => {
  const draft = state()
  const note = addNote(draft, SESSION, { text: "  why does the sidebar not scroll?  ", now: 1000, id: "note_1" })
  expect(note).toEqual({
    id: "note_1",
    text: "why does the sidebar not scroll?",
    done: false,
    created: 1000,
    updated: 1000,
    state: "open",
  })
  expect(notesOf(draft, SESSION)).toEqual([note!])
})

test("an unknown session has no notes and is not created by reading", () => {
  const draft = state()
  expect(notesOf(draft, "ses_missing")).toEqual([])
  expect(Object.keys(draft.notes)).toEqual([])
})

test("open notes sort by creation, checked-off ones go last", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "second", now: 20, id: "b" })
  addNote(draft, SESSION, { text: "third", now: 30, id: "c" })
  addNote(draft, SESSION, { text: "first", now: 10, id: "a" })
  toggleNote(draft, SESSION, "a", 40)
  expect(notesOf(draft, SESSION).map((note) => note.id)).toEqual(["b", "c", "a"])
})

test("toggle, edit and delete only touch the addressed note", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "one", now: 10, id: "a" })
  addNote(draft, SESSION, { text: "two", now: 20, id: "b" })

  toggleNote(draft, SESSION, "a", 30)
  expect(notesOf(draft, SESSION).find((note) => note.id === "a")).toMatchObject({ done: true, updated: 30 })

  setNoteText(draft, SESSION, "b", "  two, edited  ", 40)
  expect(notesOf(draft, SESSION).find((note) => note.id === "b")).toMatchObject({
    text: "two, edited",
    created: 20,
    updated: 40,
  })

  deleteNote(draft, SESSION, "a")
  expect(notesOf(draft, SESSION).map((note) => note.id)).toEqual(["b"])
})

test("a blank edit is refused instead of emptying the note", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "keep me", now: 10, id: "a" })
  setNoteText(draft, SESSION, "a", "   ", 20)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ text: "keep me", updated: 10 })
})

test("sending marks the note sent and checks it off", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "run this", now: 10, id: "a" })
  markSent(draft, SESSION, "a", 50)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent", sentAt: 50, done: true, updated: 50 })
})

test("the answer keeps text parts only and drops reasoning and tool output", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "run this", now: 10, id: "a" })
  markSent(draft, SESSION, "a", 50)

  expect(
    captureAnswers(draft, SESSION, [
      user("msg_user", 50),
      assistant("msg_a", 60, [
        { type: "reasoning", text: "thinking out loud" },
        { type: "text", text: "first paragraph" },
        { type: "tool", text: "tool output" },
        { type: "text", text: "second paragraph" },
      ]),
    ]),
  ).toBe(true)

  expect(notesOf(draft, SESSION)[0]).toMatchObject({
    state: "answered",
    answer: { text: "first paragraph\n\nsecond paragraph", messageID: "msg_a", time: 70 },
  })
})

test("an answer that started before the send, or never finished, is not captured", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "run this", now: 10, id: "a" })
  markSent(draft, SESSION, "a", 100)

  expect(
    captureAnswers(draft, SESSION, [
      assistant("msg_before", 90, [{ type: "text", text: "too early" }]),
      assistant("msg_running", 110, [{ type: "text", text: "still streaming" }], null),
      assistant("msg_empty", 120, [{ type: "reasoning", text: "no text part" }]),
    ]),
  ).toBe(false)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent" })
})

test("a long answer is capped and flagged", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "run this", now: 10, id: "a" })
  markSent(draft, SESSION, "a", 50)
  captureAnswers(draft, SESSION, [assistant("msg_a", 60, [{ type: "text", text: "x".repeat(NOTE_ANSWER_LIMIT + 25) }])])

  const answer = notesOf(draft, SESSION)[0].answer!
  expect(answer.text.length).toBe(NOTE_ANSWER_LIMIT)
  expect(answer.truncated).toBe(true)
})

test("two quick sends keep their order: the first note claims the first answer", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "first question", now: 10, id: "a" })
  addNote(draft, SESSION, { text: "second question", now: 11, id: "b" })
  markSent(draft, SESSION, "a", 100)
  markSent(draft, SESSION, "b", 101)

  // Both answers arrive in one batch; capture runs once over the whole list.
  captureAnswers(draft, SESSION, [
    assistant("msg_1", 110, [{ type: "text", text: "answer one" }]),
    assistant("msg_2", 120, [{ type: "text", text: "answer two" }]),
  ])

  const [first, second] = notesOf(draft, SESSION)
  expect(first.answer).toMatchObject({ text: "answer one", messageID: "msg_1" })
  expect(second.answer).toMatchObject({ text: "answer two", messageID: "msg_2" })
})

test("an already claimed answer is not handed to a later note", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "first", now: 10, id: "a" })
  markSent(draft, SESSION, "a", 100)
  captureAnswers(draft, SESSION, [assistant("msg_1", 110, [{ type: "text", text: "only answer" }])])

  addNote(draft, SESSION, { text: "second", now: 200, id: "b" })
  markSent(draft, SESSION, "b", 300)
  captureAnswers(draft, SESSION, [assistant("msg_1", 110, [{ type: "text", text: "only answer" }])])

  expect(notesOf(draft, SESSION).find((note) => note.id === "b")).toMatchObject({ state: "sent" })
})

test("history lists answered, then sent, then open, with manually checked-off last", () => {
  const draft = state()
  // The answered note is sent and captured first so it is the only note waiting for that answer.
  addNote(draft, SESSION, { text: "answered", now: 14, id: "answered" })
  markSent(draft, SESSION, "answered", 30)
  captureAnswers(draft, SESSION, [assistant("msg_a", 40, [{ type: "text", text: "done" }])])

  addNote(draft, SESSION, { text: "sent", now: 13, id: "sent" })
  markSent(draft, SESSION, "sent", 20)
  addNote(draft, SESSION, { text: "open", now: 10, id: "open" })
  addNote(draft, SESSION, { text: "checked", now: 11, id: "checked" })
  toggleNote(draft, SESSION, "checked", 12)

  expect(historyNotes(draft, SESSION).map((note) => note.id)).toEqual(["answered", "sent", "open", "checked"])
})

test("project fields are stored when the session carries them and omitted when it does not", () => {
  const draft = state()
  addNote(draft, SESSION, {
    text: "with project",
    now: 1,
    id: "a",
    projectID: "proj_1",
    location: { directory: "/repo" },
  })
  addNote(draft, SESSION, { text: "without project", now: 2, id: "b" })

  const [first, second] = notesOf(draft, SESSION)
  expect(first).toMatchObject({ projectID: "proj_1", location: { directory: "/repo" } })
  expect(second.projectID).toBeUndefined()
  expect(second.location).toBeUndefined()
})

test("clearing checked notes keeps the ones that captured an answer", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "clutter", now: 10, id: "clutter" })
  toggleNote(draft, SESSION, "clutter", 11)
  addNote(draft, SESSION, { text: "still waiting", now: 12, id: "sent" })
  markSent(draft, SESSION, "sent", 20)
  addNote(draft, SESSION, { text: "answered", now: 13, id: "answered" })
  markSent(draft, SESSION, "answered", 30)
  captureAnswers(draft, SESSION, [assistant("msg_a", 40, [{ type: "text", text: "kept answer" }])])
  addNote(draft, SESSION, { text: "untouched", now: 14, id: "open" })

  expect(clearDone(draft, SESSION)).toBe(true)
  // Captured answers are the archive, and a sent note still waits for one: neither may be swept.
  expect(
    notesOf(draft, SESSION)
      .map((note) => note.id)
      .sort(),
  ).toEqual(["answered", "open", "sent"])
  expect(clearDone(draft, SESSION)).toBe(false)
})

test("a prototype-shaped session id cannot reach the note map's prototype", () => {
  const draft = state()
  for (const key of ["__proto__", "constructor", "prototype"]) {
    expect(addNote(draft, key, { text: "nope", now: 1, id: "x" })).toBeUndefined()
    expect(notesOf(draft, key)).toEqual([])
  }
  expect({}.hasOwnProperty("nope")).toBe(false)
  expect(Object.keys(draft.notes)).toEqual([])
})

test("mutating a missing note is a no-op instead of a throw", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "kept", now: 10, id: "a" })
  toggleNote(draft, SESSION, "missing", 20)
  setNoteText(draft, SESSION, "missing", "text", 20)
  deleteNote(draft, SESSION, "missing")
  expect(notesOf(draft, SESSION)).toHaveLength(1)
})
