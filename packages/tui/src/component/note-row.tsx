/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { NOTE_ROW_CHARS, notePreview, type Note } from "../util/notes"

/** One action: a two-cell box owns the click, the glyph sits inside it. */
function Icon(props: { id: string; glyph: string; theme: Plugin.Context["theme"]; onPress: () => void }) {
  return (
    <box id={props.id} width={2} flexShrink={0} onMouseUp={() => props.onPress()}>
      <text fg={props.theme.text.base} attributes={TextAttributes.BOLD}>
        {props.glyph}
      </text>
    </box>
  )
}

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
  const answer = () => props.note.answer

  return (
    <box id={`note-row-${props.note.id}`} flexDirection="row" gap={2} minWidth={0}>
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
          appears on hover shifts the text and disappears exactly when it is needed. Each icon is a box
          of its own, so the click lands on the box rather than on whatever width the glyph happens to
          render with. */}
      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        onMouseUp={(event: { stopPropagation(): void }) => event.stopPropagation()}
      >
        <Show when={answer() || notePreview(props.note.text).length >= NOTE_ROW_CHARS}>
          <Icon id={`note-view-${props.note.id}`} glyph="▤" theme={theme} onPress={() => props.onView()} />
        </Show>
        <Icon id={`note-edit-${props.note.id}`} glyph="✎" theme={theme} onPress={() => props.onEdit()} />
        <Icon id={`note-send-${props.note.id}`} glyph="▶" theme={theme} onPress={() => props.onSend()} />
        <Icon id={`note-delete-${props.note.id}`} glyph="✖" theme={theme} onPress={() => props.onDelete()} />
      </box>
    </box>
  )
}
