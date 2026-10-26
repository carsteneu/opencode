/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DialogNote } from "../src/component/dialog-note"
import { DialogNoteDetail, historyOptions, openNotesHistory, searchNotes } from "../src/component/dialog-notes-history"
import type { Plugin } from "@opencode/plugin/tui"
import type { Note } from "../src/util/notes"
import { renderLocal } from "./fixture/local"

function note(id: string, text: string, extra: Partial<Note> = {}): Note {
  return { id, text, done: false, created: 1, updated: 1, state: "open", ...extra }
}

async function openNoteDialog(input: { title: string; value?: string }) {
  const setup = await renderLocal()
  const confirmed: string[] = []
  setup.dialog.replace(() => (
    <DialogNote title={input.title} value={input.value} onConfirm={(text) => confirmed.push(text)} />
  ))
  await setup.waitForFrame((frame) => frame.includes(input.title))
  // The dialog focuses its textarea on the next tick.
  await Bun.sleep(20)
  await setup.renderOnce()
  return { setup, confirmed }
}

test("Enter saves what was typed", async () => {
  const { setup, confirmed } = await openNoteDialog({ title: "Add a note" })
  try {
    await setup.mockInput.typeText("why the stall")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(confirmed).toEqual(["why the stall"])
    // The editor closes itself, so no caller can forget it.
    expect(setup.dialog.stack.length).toBe(0)
  } finally {
    setup.renderer.destroy()
  }
})

test("Ctrl+Enter inserts a newline instead of saving", async () => {
  const { setup, confirmed } = await openNoteDialog({ title: "Add a note" })
  try {
    await setup.mockInput.typeText("first line")
    setup.mockInput.pressEnter({ ctrl: true })
    await setup.renderOnce()
    await setup.mockInput.typeText("second line")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("first line")
    expect(frame).toContain("second line")
    expect(confirmed).toEqual([])

    setup.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(confirmed).toEqual(["first line\nsecond line"])
  } finally {
    setup.renderer.destroy()
  }
})

test("Escape discards the edit", async () => {
  const { setup, confirmed } = await openNoteDialog({ title: "Edit note", value: "original" })
  try {
    await setup.mockInput.typeText(" changed")
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    await Bun.sleep(0)
    expect(confirmed).toEqual([])
    expect(setup.dialog.stack.length).toBe(0)
  } finally {
    setup.renderer.destroy()
  }
})

test("history options mark the state and preview the answer", () => {
  const list = [
    note("a", "answered question", {
      state: "answered",
      done: true,
      sentAt: 5,
      answer: { text: "the answer\nsecond line", messageID: "msg_1", time: 9 },
    }),
    note("b", "sent question", { state: "sent", done: true, sentAt: 4 }),
    note("c", "open question"),
  ]
  const options = historyOptions(list)
  expect(options.map((option) => option.value.id)).toEqual(["a", "b", "c"])
  expect(options[0].title).toContain("answered question")
  expect(options[0].description).toBe("the answer")
  expect(options[1].description).toBe("waiting for an answer")
  expect(options[2].description).toBeUndefined()
})

test("history search looks at the question and the answer", () => {
  const options = historyOptions([
    note("a", "why does the sidebar scroll?", {
      state: "answered",
      done: true,
      answer: { text: "Because the scrollbox has no content bounds.", messageID: "msg_1", time: 9 },
    }),
    note("b", "unrelated", {}),
  ])

  // Answer-only text must match: the question does not contain the word.
  expect(searchNotes("scrollbox", options).map((option) => option.value.id)).toEqual(["a"])
  // Case-insensitive, and the question counts too.
  expect(searchNotes("SIDEBAR", options).map((option) => option.value.id)).toEqual(["a"])
  // An empty query keeps everything, so the dialog opens with the full list.
  expect(searchNotes("   ", options)).toHaveLength(2)
  expect(searchNotes("nothing here", options)).toHaveLength(0)
})

test("the detail view shows the full question, the full answer and the timestamps", async () => {
  const setup = await renderLocal()
  try {
    setup.dialog.replace(() => (
      <DialogNoteDetail
        note={note("a", "does the answer get capped?", {
          done: true,
          state: "answered",
          created: Date.UTC(2026, 9, 26, 10, 0),
          sentAt: Date.UTC(2026, 9, 26, 10, 1),
          answer: {
            text: "At four thousand characters.\nEverything after that is cut.",
            messageID: "msg_1",
            time: Date.UTC(2026, 9, 26, 10, 2),
          },
        })}
      />
    ))
    await setup.waitForFrame((frame) => frame.includes("does the answer get capped?"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("At four thousand characters.")
    expect(frame).toContain("Everything after that is cut.")
    // Plain text, no markdown: asterisks stay visible.
    setup.dialog.clear()
  } finally {
    setup.renderer.destroy()
  }
})

test("a sent note without an answer says so", async () => {
  const setup = await renderLocal()
  try {
    setup.dialog.replace(() => <DialogNoteDetail note={note("a", "still running", { state: "sent", done: true })} />)
    await setup.waitForFrame((frame) => frame.includes("still running"))
    expect(setup.captureCharFrame()).toContain("no answer yet")
  } finally {
    setup.renderer.destroy()
  }
})

function historyUi(pick: Note | undefined) {
  const calls: string[] = []
  const ui = {
    dialog: {
      alert: async () => {
        calls.push("alert")
      },
      select: async () => {
        calls.push("select")
        return pick
      },
      show: () => calls.push("show"),
      set: () => calls.push("set"),
      clear: () => {},
      confirm: async () => false,
      prompt: async () => undefined,
    },
  } as unknown as Plugin.Context["ui"]
  return { ui, calls }
}

test("picking a note opens the detail, cancelling opens nothing", async () => {
  const picked = historyUi(note("a", "picked"))
  await openNotesHistory(picked.ui, [note("a", "picked")])
  // The select closes on a pick, so the detail is a second dialog.
  expect(picked.calls).toEqual(["select", "show", "set"])

  const cancelled = historyUi(undefined)
  await openNotesHistory(cancelled.ui, [note("a", "picked")])
  expect(cancelled.calls).toEqual(["select"])
})

test("an empty history says so instead of opening an empty list", async () => {
  const empty = historyUi(undefined)
  await openNotesHistory(empty.ui, [])
  expect(empty.calls).toEqual(["alert"])
})
