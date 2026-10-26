import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  NOTE_ANSWER_LIMIT,
  NOTE_ROW_CHARS,
  addNote,
  captureAnswers,
  clearDone,
  deleteNote,
  historyNotes,
  markSent,
  notePreview,
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
  options: { completed?: number | null; finish?: string } = {},
) {
  const completed = options.completed === undefined ? created + 10 : options.completed
  return {
    id,
    type: "assistant",
    // null means still streaming: a default parameter cannot express "explicitly absent".
    time: completed === null ? { created } : { created, completed },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    content,
    ...(options.finish === undefined ? {} : { finish: options.finish }),
  } as unknown as SessionMessageInfo
}

function user(id: string, text: string, created = 0) {
  return { id, type: "user", time: { created }, text } as unknown as SessionMessageInfo
}

/** A note that was sent, anchored on the user message `sentID`. */
function sent(state: NotesState, id = "note", sentID = "msg_note", at = 100) {
  addNote(state, SESSION, { text: "run this", now: 10, id })
  markSent(state, SESSION, id, sentID, at)
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

test("a note row previews one flat line and keeps the note itself whole", () => {
  expect(NOTE_ROW_CHARS).toBe(80)
  expect(notePreview("short question")).toBe("short question")
  // Newlines and runs of spaces collapse: the row is one line.
  expect(notePreview("first line\n\nsecond   line")).toBe("first line second line")
  const long = "x".repeat(200)
  const preview = notePreview(long)
  expect(preview).toHaveLength(NOTE_ROW_CHARS)
  expect(preview.endsWith("…")).toBe(true)

  // The stored note is untouched: it is sent as the prompt.
  const draft = state()
  const note = addNote(draft, SESSION, { text: long, now: 1, id: "long" })!
  expect(note.text).toBe(long)
  expect(notesOf(draft, SESSION)[0]!.text).toBe(long)
})

test("open notes sort newest first, checked-off ones go last", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "second", now: 20, id: "b" })
  addNote(draft, SESSION, { text: "third", now: 30, id: "c" })
  addNote(draft, SESSION, { text: "first", now: 10, id: "a" })
  toggleNote(draft, SESSION, "a", 40)
  expect(notesOf(draft, SESSION).map((note) => note.id)).toEqual(["c", "b", "a"])
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

test("sending marks the note sent, checks it off and anchors it on its message", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({
    state: "sent",
    sentAt: 50,
    sentID: "msg_a",
    done: true,
    updated: 50,
  })
})

test("re-sending re-anchors the note and drops the answer of the previous turn", () => {
  const draft = state()
  sent(draft, "a", "msg_first", 50)
  captureAnswers(draft, SESSION, [
    user("msg_first", "run this"),
    assistant("msg_1", 60, [{ type: "text", text: "old" }]),
  ])
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "answered", answer: { text: "old" } })

  markSent(draft, SESSION, "a", "msg_second", 100)
  // Keeping the old answer would leave the note looking answered while a new turn runs.
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent", sentID: "msg_second" })
  expect(notesOf(draft, SESSION)[0].answer).toBeUndefined()

  captureAnswers(draft, SESSION, [
    user("msg_first", "run this"),
    assistant("msg_1", 60, [{ type: "text", text: "old" }]),
    user("msg_second", "run this"),
    assistant("msg_2", 110, [{ type: "text", text: "new" }]),
  ])
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "answered", answer: { text: "new" } })
})

test("the answer keeps text parts only and drops reasoning and tool output", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)

  expect(
    captureAnswers(draft, SESSION, [
      user("msg_a", "run this"),
      assistant("msg_1", 60, [
        { type: "reasoning", text: "thinking out loud" },
        { type: "text", text: "first paragraph" },
        { type: "text", text: "second paragraph" },
      ]),
    ]),
  ).toBe(true)

  expect(notesOf(draft, SESSION)[0]).toMatchObject({
    state: "answered",
    answer: { text: "first paragraph\n\nsecond paragraph", messageID: "msg_1", time: 70 },
  })
})

test("the capture does not depend on the clocks agreeing", () => {
  const draft = state()
  // A client clock far ahead of the server, or a send recorded late, must not matter: the note is
  // anchored on its own user message, not on a timestamp.
  sent(draft, "a", "msg_a", 9_999_999)
  expect(
    captureAnswers(draft, SESSION, [
      user("msg_a", "run this", 10),
      assistant("msg_1", 20, [{ type: "text", text: "the answer" }]),
    ]),
  ).toBe(true)
  expect(notesOf(draft, SESSION)[0].answer).toMatchObject({ text: "the answer" })
})

test("a tool-using turn captures its final answer, not the intermediate step", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)

  captureAnswers(draft, SESSION, [
    user("msg_a", "run this"),
    assistant("msg_1", 60, [
      { type: "text", text: "Let me look at the sidebar component." },
      { type: "tool", text: "read output" },
    ]),
    assistant("msg_2", 80, [{ type: "text", text: "It does not scroll because the box has no height." }]),
  ])

  expect(notesOf(draft, SESSION)[0].answer).toMatchObject({
    text: "It does not scroll because the box has no height.",
    messageID: "msg_2",
  })
})

test("a streaming answer, an errored turn and a textless message are not captured", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)

  expect(
    captureAnswers(draft, SESSION, [
      user("msg_a", "run this"),
      assistant("msg_1", 60, [{ type: "text", text: "still streaming" }], { completed: null }),
      assistant("msg_2", 70, [{ type: "text", text: "partial" }], { finish: "error" }),
      assistant("msg_3", 80, [{ type: "reasoning", text: "no text part" }]),
    ]),
  ).toBe(false)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent" })
})

test("an errored turn does not let the note claim a later turn's answer", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)

  // The note's own turn errored, so it produced no answer. What follows is a different question the
  // user typed themselves; that answer belongs to no note.
  expect(
    captureAnswers(draft, SESSION, [
      user("msg_a", "run this"),
      assistant("msg_1", 60, [{ type: "text", text: "boom" }], { finish: "error" }),
      user("msg_other", "an unrelated question", 200),
      assistant("msg_2", 210, [{ type: "text", text: "an unrelated answer" }]),
    ]),
  ).toBe(false)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent" })
})

test("a note whose own message has not been echoed yet waits", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)
  expect(captureAnswers(draft, SESSION, [assistant("msg_1", 60, [{ type: "text", text: "orphan" }])])).toBe(false)
  expect(notesOf(draft, SESSION)[0]).toMatchObject({ state: "sent" })
})

test("a long answer is capped and flagged without splitting a surrogate pair", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 50)
  // The emoji straddles the cap: slicing UTF-16 units would leave a lone high surrogate behind.
  const text = "x".repeat(NOTE_ANSWER_LIMIT - 1) + "😀" + "tail"
  captureAnswers(draft, SESSION, [user("msg_a", "run this"), assistant("msg_1", 60, [{ type: "text", text }])])

  const answer = notesOf(draft, SESSION)[0].answer!
  expect(answer.truncated).toBe(true)
  expect(answer.text.length).toBe(NOTE_ANSWER_LIMIT - 1)
  expect(/[\uD800-\uDBFF]$/.test(answer.text)).toBe(false)
})

test("two notes each keep their own answer", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "first question", now: 10, id: "a" })
  markSent(draft, SESSION, "a", "msg_a", 100)
  addNote(draft, SESSION, { text: "second question", now: 11, id: "b" })
  markSent(draft, SESSION, "b", "msg_b", 101)

  captureAnswers(draft, SESSION, [
    user("msg_a", "first question"),
    assistant("msg_1", 110, [{ type: "text", text: "answer one" }]),
    user("msg_b", "second question"),
    assistant("msg_2", 120, [{ type: "text", text: "answer two" }]),
  ])

  // Addressed by id: the listing order is display order, not identity.
  const first = notesOf(draft, SESSION).find((note) => note.id === "a")!
  const second = notesOf(draft, SESSION).find((note) => note.id === "b")!
  expect(first.answer).toMatchObject({ text: "answer one", messageID: "msg_1" })
  expect(second.answer).toMatchObject({ text: "answer two", messageID: "msg_2" })
})

test("an answer already claimed by another note is not handed out twice", () => {
  const draft = state()
  sent(draft, "a", "msg_a", 100)
  captureAnswers(draft, SESSION, [user("msg_a", "run this"), assistant("msg_1", 110, [{ type: "text", text: "only" }])])

  // A second note anchored on the same message (a duplicated row) must not take the same answer.
  addNote(draft, SESSION, { text: "again", now: 200, id: "b" })
  markSent(draft, SESSION, "b", "msg_a", 300)
  captureAnswers(draft, SESSION, [user("msg_a", "run this"), assistant("msg_1", 110, [{ type: "text", text: "only" }])])

  expect(notesOf(draft, SESSION).find((note) => note.id === "b")).toMatchObject({ state: "sent" })
})

test("history lists answered, then sent, then open, with manually checked-off last", () => {
  const draft = state()
  // The answered note is sent and captured first so it is the only note waiting for that answer.
  addNote(draft, SESSION, { text: "answered", now: 14, id: "answered" })
  markSent(draft, SESSION, "answered", "msg_a", 30)
  captureAnswers(draft, SESSION, [user("msg_a", "answered"), assistant("msg_1", 40, [{ type: "text", text: "done" }])])

  addNote(draft, SESSION, { text: "sent", now: 13, id: "sent" })
  markSent(draft, SESSION, "sent", "msg_b", 20)
  addNote(draft, SESSION, { text: "open", now: 10, id: "open" })
  addNote(draft, SESSION, { text: "checked", now: 11, id: "checked" })
  toggleNote(draft, SESSION, "checked", 12)

  expect(historyNotes(draft, SESSION).map((note) => note.id)).toEqual(["answered", "sent", "open", "checked"])
})

test("clearing checked notes keeps the ones that captured an answer", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "clutter", now: 10, id: "clutter" })
  toggleNote(draft, SESSION, "clutter", 11)
  sent(draft, "sent", "msg_b", 20)
  addNote(draft, SESSION, { text: "answered", now: 13, id: "answered" })
  markSent(draft, SESSION, "answered", "msg_a", 30)
  captureAnswers(draft, SESSION, [user("msg_a", "answered"), assistant("msg_1", 40, [{ type: "text", text: "kept" }])])
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

  const first = notesOf(draft, SESSION).find((note) => note.id === "a")!
  const second = notesOf(draft, SESSION).find((note) => note.id === "b")!
  expect(first).toMatchObject({ projectID: "proj_1", location: { directory: "/repo" } })
  expect(second.projectID).toBeUndefined()
  expect(second.location).toBeUndefined()
})

test("a prototype-shaped session id cannot replace the note map's prototype", () => {
  const draft = state()
  for (const key of ["__proto__", "constructor", "prototype"]) {
    expect(addNote(draft, key, { text: "nope", now: 1, id: "x" })).toBeUndefined()
    expect(notesOf(draft, key)).toEqual([])
  }
  expect(Object.getPrototypeOf(draft.notes)).toBe(Object.prototype)
  expect(Object.keys(draft.notes)).toEqual([])
})

test("a corrupt state file degrades to no notes instead of throwing", () => {
  // The state file is JSON the user's own machine owns; a hand-edited file must not crash the sidebar.
  expect(notesOf({ notes: null as never }, SESSION)).toEqual([])
  expect(notesOf({ notes: { [SESSION]: [null as never] } }, SESSION)).toEqual([])
  expect(captureAnswers({ notes: { [SESSION]: [null as never] } }, SESSION, [])).toBe(false)
})

test("mutating a missing note is a no-op instead of a throw", () => {
  const draft = state()
  addNote(draft, SESSION, { text: "kept", now: 10, id: "a" })
  toggleNote(draft, SESSION, "missing", 20)
  setNoteText(draft, SESSION, "missing", "text", 20)
  deleteNote(draft, SESSION, "missing")
  markSent(draft, SESSION, "missing", "msg_x", 20)
  expect(notesOf(draft, SESSION)).toHaveLength(1)
})
