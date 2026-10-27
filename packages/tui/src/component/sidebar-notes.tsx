/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import {
  addNote,
  captureAnswers,
  clearDone as clearDoneNotes,
  deleteNote,
  historyNotes,
  markSent,
  notesOf,
  pendingAnswers,
  setNoteText,
  toggleNote,
  type Note,
  type NotesState,
} from "../util/notes"
import { NoteRow } from "./note-row"
import { DialogNote } from "./dialog-note"
import { openNoteDetail, openNotesHistory } from "./dialog-notes-history"

/** Rows the block renders before it hands the rest to the history dialog. */
export const NOTE_VISIBLE_LIMIT = 8

function fail(context: Plugin.Context, message: string, error: unknown) {
  context.ui.toast.show({
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
    variant: "error",
    duration: 5000,
  })
}

function excerpt(text: string) {
  const line = text.split("\n").find((value) => value.trim().length > 0) ?? text
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/**
 * The notes of the sidebar block: one durable store keyed by session, plus the actions the block,
 * the keymap commands and the dialogs share.
 */
export function useNotes(context: Plugin.Context) {
  const [state, update] = context.storage.store<NotesState>("notes", { initial: { notes: {} } })
  const [view, updateView] = context.storage.store("view", { initial: { open: true } })

  const routed = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const save = (target: string, mutation: (draft: NotesState) => void) =>
    update(mutation).catch((error) => fail(context, "Failed to save the notes", error))

  function add(target = routed()) {
    if (!target) {
      context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    const sessionID = target
    context.ui.dialog.show(() => (
      <DialogNote
        title="Add a note"
        placeholder="A question or point to come back to"
        onConfirm={(text) => {
          // projectID and location are captured now so a later project view needs no migration.
          const session = context.data.session.get(sessionID)
          void save(sessionID, (draft) =>
            addNote(draft, sessionID, {
              text,
              projectID: session?.projectID,
              location: session?.location,
            }),
          )
        }}
      />
    ))
  }

  /**
   * Takes the composer's text as a note and empties the field. Returns false when there was nothing
   * to take, so the caller can say so instead of leaving the click without an answer.
   */
  function saveForLater(target = routed()) {
    const text = context.ui.composer.text().trim()
    if (!text) return false
    if (!target) {
      context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return true
    }
    const sessionID = target
    const session = context.data.session.get(sessionID)
    void save(sessionID, (draft) =>
      addNote(draft, sessionID, { text, projectID: session?.projectID, location: session?.location }),
    )
    context.ui.composer.clear()
    return true
  }

  /** The one entry point behind the footer button, the keybinding and the palette command. */
  function parkPrompt() {
    if (saveForLater()) return
    context.ui.toast.show({ message: "Nothing to save for later", variant: "warning" })
  }

  function edit(target: string, note: Note) {
    context.ui.dialog.show(() => (
      <DialogNote
        title="Edit note"
        value={note.text}
        onConfirm={(text) => void save(target, (draft) => setNoteText(draft, target, note.id, text))}
      />
    ))
  }

  // A second click on the send action while the first is still in flight would post the prompt twice
  // — two turns, two charges — so sends are serialized per note. The guard covers the state write
  // too: releasing it right after the enqueue leaves the note still unchecked on disk, and a click in
  // that window posts again.
  const sending = new Set<string>()

  async function send(target: string, note: Note) {
    const key = `${target}:${note.id}`
    if (sending.has(key)) return
    sending.add(key)
    try {
      const sentID = await context.data.session.enqueue({ sessionID: target, text: note.text })
      await save(target, (draft) => markSent(draft, target, note.id, sentID, Date.now()))
      // The answer may already be in the transcript — a fast turn, or a steer into a running one — and
      // marking the note sent changes no message, so nothing else would trigger the capture.
      capture(target)
    } catch (error) {
      fail(context, "Failed to send the note", error)
    } finally {
      sending.delete(key)
    }
  }

  function toggle(target: string, note: Note) {
    void save(target, (draft) => toggleNote(draft, target, note.id))
  }

  async function remove(target: string, note: Note) {
    const confirmed = await context.ui.dialog.confirm({
      title: "Delete note",
      message: `Delete "${excerpt(note.text)}"?`,
      label: { confirm: "delete" },
    })
    if (!confirmed) return
    void save(target, (draft) => deleteNote(draft, target, note.id))
  }

  function history(target = routed()) {
    if (!target) {
      context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    return openNotesHistory(context.ui, historyNotes(state, target))
  }

  function clearDone(target = routed()) {
    if (!target) {
      context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    void save(target, (draft) => {
      clearDoneNotes(draft, target)
    })
  }

  /**
   * Attaches the answer each sent note caused. Probing first keeps a streaming turn from writing the
   * state file on every token: an answer that cannot be matched yet never reaches `update`.
   */
  function capture(
    target: string,
    messages: readonly SessionMessageInfo[] = context.data.session.message.list(target),
  ) {
    if (pendingAnswers(notesOf(state, target), messages).size === 0) return
    void save(target, (draft) => {
      captureAnswers(draft, target, messages)
    })
  }

  return {
    state,
    view,
    update,
    updateView,
    sessionID: routed,
    add,
    edit,
    send,
    toggle,
    remove,
    history,
    clearDone,
    capture,
    saveForLater,
    parkPrompt,
  }
}

/**
 * The always-mounted half of the plugin: commands work while the sidebar is closed, and an answer is
 * captured whether or not the block is on screen.
 */
export function NotesRuntime(props: { context: Plugin.Context }) {
  const notes = useNotes(props.context)
  const sessionID = createMemo(() => notes.sessionID())
  // A turn streams one message's parts many times; keying on the newest *completed* assistant message
  // keeps the capture from re-scanning the transcript on every token.
  const completed = createMemo(() => {
    const target = sessionID()
    if (!target) return ""
    const messages = props.context.data.session.message.list(target)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.type === "assistant" && message.time.completed !== undefined)
        return `${messages.length}:${message.id}`
    }
    return ""
  })
  createEffect(
    on(completed, (signature) => {
      if (!signature) return
      const target = sessionID()
      if (target) notes.capture(target)
    }),
  )

  // Bindings come from config.keybinds, so every command stays rebindable and in the palette.
  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "notes.add",
        title: "Add a prompt note",
        description: "Note a question or point for the current session instead of the transcript",
        group: "Notes",
        palette: true,
        run: () => notes.add(),
      },
      {
        id: "notes.save_for_later",
        title: "Save prompt for later",
        description: "Park whatever is typed in the prompt as a note instead of sending it",
        group: "Notes",
        palette: true,
        run: () => notes.parkPrompt(),
      },
      {
        id: "notes.history",
        title: "Prompt note history",
        description: "Browse this session's notes and the answers they captured",
        group: "Notes",
        palette: true,
        run: () => void notes.history(),
      },
      {
        id: "notes.toggle",
        title: "Toggle prompt notes",
        description: "Show or hide the prompt notes block in the session sidebar",
        group: "Notes",
        palette: true,
        run: () =>
          void notes
            .updateView((draft) => {
              draft.open = !draft.open
            })
            .catch((error) => console.error("Failed to persist the notes sidebar state", error)),
      },
      {
        id: "notes.clear_done",
        title: "Clear checked notes",
        description: "Remove checked-off notes that never captured an answer",
        group: "Notes",
        palette: true,
        run: () => notes.clearDone(),
      },
    ],
  }))

  return null
}

export function SidebarNotes(props: { context: Plugin.Context; sessionID: string }) {
  const notes = useNotes(props.context)
  const theme = props.context.theme
  const list = createMemo(() => notesOf(notes.state, props.sessionID))
  const open = createMemo(() => list().filter((note) => !note.done).length)
  // A long list would push every other sidebar block off the screen: the block shows the newest
  // rows and hands the rest to the history dialog, which searches.
  const visible = createMemo(() => list().slice(0, NOTE_VISIBLE_LIMIT))
  const hidden = createMemo(() => Math.max(0, list().length - visible().length))

  return (
    <box gap={1}>
      <box flexDirection="row" gap={1} minWidth={0}>
        <box
          id="notes-toggle"
          flexShrink={0}
          onMouseDown={() =>
            void notes
              .updateView((draft) => {
                draft.open = !draft.open
              })
              .catch((error) => console.error("Failed to persist the notes sidebar state", error))
          }
        >
          <text fg={theme.text.base}>{notes.view.open ? "▼" : "▶"}</text>
        </box>
        <text fg={theme.text.base} flexGrow={1} flexShrink={1} minWidth={0}>
          <b>Prompt Notes</b>
          <span style={{ fg: theme.text.muted }}> ({open()})</span>
        </text>
        <box id="notes-history" flexShrink={0} onMouseUp={() => void notes.history(props.sessionID)}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            ◷
          </text>
        </box>
        <box id="notes-add" flexShrink={0} onMouseUp={() => notes.add(props.sessionID)}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            +
          </text>
        </box>
      </box>
      <Show when={notes.view.open}>
        <Show when={list().length > 0} fallback={<text fg={theme.text.faint}>No notes yet</text>}>
          <box gap={1}>
            <For each={visible()}>
              {(note) => (
                <NoteRow
                  context={props.context}
                  note={note}
                  onToggle={() => notes.toggle(props.sessionID, note)}
                  onEdit={() => notes.edit(props.sessionID, note)}
                  onSend={() => void notes.send(props.sessionID, note)}
                  onView={() => openNoteDetail(props.context.ui, note)}
                  onDelete={() => void notes.remove(props.sessionID, note)}
                />
              )}
            </For>
            <Show when={hidden() > 0}>
              <box id="notes-overflow" onMouseUp={() => void notes.history(props.sessionID)}>
                <text fg={theme.text.muted}>{`⋮ ${hidden()} more → history`}</text>
              </box>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}
