/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import type { Note } from "../util/notes"

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim().length > 0) ?? ""
}

export function NoteRow(props: {
  context: Plugin.Context
  note: Note
  onToggle: () => void
  onEdit: () => void
  onSend: () => void
  onDelete: () => void
}) {
  const theme = props.context.theme
  // Hover and expansion are memory-only: which row the pointer is over is not worth a disk write.
  const [hovered, setHovered] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
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
      gap={1}
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
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <text
          fg={props.note.done ? theme.text.muted : theme.text.base}
          wrapMode="word"
          attributes={props.note.done ? TextAttributes.DIM : undefined}
        >
          {props.note.text}
        </text>
        <Show when={answer()}>
          {(stored) => (
            <box id={`note-answer-${props.note.id}`} onMouseUp={() => setExpanded((value) => !value)}>
              <text fg={theme.text.faint} wrapMode={expanded() ? "word" : "none"} truncate={!expanded()}>
                {(expanded() ? "▾ " : "▸ ") + (expanded() ? stored().text : firstLine(stored().text))}
              </text>
            </box>
          )}
        </Show>
      </box>
      {/* Without hover the row gives the whole width to the question. */}
      <Show when={hovered()}>
        <box
          flexDirection="row"
          gap={2}
          flexShrink={0}
          onMouseOver={enter}
          onMouseOut={leave}
          onMouseUp={(event: { stopPropagation(): void }) => event.stopPropagation()}
        >
          <text
            id={`note-edit-${props.note.id}`}
            fg={theme.text.base}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => props.onEdit()}
          >
            ✎
          </text>
          <text
            id={`note-send-${props.note.id}`}
            fg={theme.text.base}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => props.onSend()}
          >
            ▶
          </text>
          <text
            id={`note-delete-${props.note.id}`}
            fg={theme.text.base}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => props.onDelete()}
          >
            ✖
          </text>
        </box>
      </Show>
    </box>
  )
}
