/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { NOTE_ROW_CHARS, notePreview, type Note } from "../util/notes"

export function NoteRow(props: {
  context: Plugin.Context
  note: Note
  onToggle: () => void
  onEdit: () => void
  onSend: () => void
  onView: () => void
  onDelete: () => void
}) {
  const theme = props.context.theme
  // Hover is memory-only: which row the pointer is over is not worth a disk write.
  const [hovered, setHovered] = createSignal(false)
  const answer = () => props.note.answer

  // Entering a child fires `out` on the row, so a strict toggle would unmount the actions exactly when
  // the pointer reaches them. Leaving is therefore deferred; any hover inside the row cancels it.
  let leaving: ReturnType<typeof setTimeout> | undefined
  const enter = () => {
    clearTimeout(leaving)
    setHovered(true)
  }
  const leave = () => {
    clearTimeout(leaving)
    leaving = setTimeout(() => setHovered(false), 200)
  }
  onCleanup(() => clearTimeout(leaving))

  return (
    <box
      id={`note-row-${props.note.id}`}
      flexDirection="row"
      gap={2}
      minWidth={0}
      onMouseOver={enter}
      onMouseOut={leave}
    >
      <box id={`note-check-${props.note.id}`} flexShrink={0} onMouseUp={() => props.onToggle()}>
        <text
          fg={props.note.done ? theme.text.feedback.success.base : theme.text.muted}
          attributes={TextAttributes.BOLD}
        >
          {props.note.done ? "✔" : "○"}
        </text>
      </box>
      {/* Two lines are reserved: the row keeps its height, and the text column yields to the actions
          instead of pushing them out when the note is long. */}
      <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} height={2}>
        <text
          fg={props.note.done ? theme.text.muted : theme.text.base}
          wrapMode="word"
          attributes={props.note.done ? TextAttributes.DIM : undefined}
        >
          {notePreview(props.note.text)}
        </text>
      </box>
      {/* The actions keep their column whether or not the pointer is over the row: an icon that only
          appears on hover shifts the text and disappears exactly when it is needed. */}
      <box
        flexDirection="row"
        gap={2}
        flexShrink={0}
        onMouseOver={enter}
        onMouseOut={leave}
        onMouseUp={(event: { stopPropagation(): void }) => event.stopPropagation()}
      >
        <Show when={answer() || notePreview(props.note.text).length >= NOTE_ROW_CHARS}>
          <text
            id={`note-view-${props.note.id}`}
            fg={hovered() ? theme.text.base : theme.text.faint}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => props.onView()}
          >
            ▤
          </text>
        </Show>
        <text
          id={`note-edit-${props.note.id}`}
          fg={hovered() ? theme.text.base : theme.text.faint}
          attributes={TextAttributes.BOLD}
          onMouseUp={() => props.onEdit()}
        >
          ✎
        </text>
        <text
          id={`note-send-${props.note.id}`}
          fg={hovered() ? theme.text.base : theme.text.faint}
          attributes={TextAttributes.BOLD}
          onMouseUp={() => props.onSend()}
        >
          ▶
        </text>
        <text
          id={`note-delete-${props.note.id}`}
          fg={hovered() ? theme.text.base : theme.text.faint}
          attributes={TextAttributes.BOLD}
          onMouseUp={() => props.onDelete()}
        >
          ✖
        </text>
      </box>
    </box>
  )
}
