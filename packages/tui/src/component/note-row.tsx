/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { NOTE_ROW_CHARS, notePreview, type Note } from "../util/notes"

/** One action: a two-cell box owns the click, the glyph sits inside it. */
function Icon(props: {
  id: string
  glyph: string
  theme: Plugin.Context["theme"]
  bright: boolean
  onPress: () => void
}) {
  return (
    <box id={props.id} width={2} flexShrink={0} onMouseUp={() => props.onPress()}>
      <text fg={props.bright ? props.theme.text.base : props.theme.text.faint} attributes={TextAttributes.BOLD}>
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
          appears on hover shifts the text and disappears exactly when it is needed. Each icon is a box
          of its own, so the click lands on the box rather than on whatever width the glyph happens to
          render with. */}
      <box
        flexDirection="row"
        flexShrink={0}
        onMouseOver={enter}
        onMouseOut={leave}
        onMouseUp={(event: { stopPropagation(): void }) => event.stopPropagation()}
      >
        <Show when={answer() || notePreview(props.note.text).length >= NOTE_ROW_CHARS}>
          <Icon id={`note-view-${props.note.id}`} glyph="▤" theme={theme} bright={hovered()} onPress={() => props.onView()} />
        </Show>
        <Icon id={`note-edit-${props.note.id}`} glyph="✎" theme={theme} bright={hovered()} onPress={() => props.onEdit()} />
        <Icon id={`note-send-${props.note.id}`} glyph="▶" theme={theme} bright={hovered()} onPress={() => props.onSend()} />
        <Icon id={`note-delete-${props.note.id}`} glyph="✖" theme={theme} bright={hovered()} onPress={() => props.onDelete()} />
      </box>
    </box>
  )
}
