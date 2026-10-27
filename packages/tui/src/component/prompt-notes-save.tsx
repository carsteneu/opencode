/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useNotes } from "./sidebar-notes"

/**
 * The composer's other exit: text typed into the prompt can be parked as a note instead of sent.
 * It sits in the footer row and stays visible whether or not the field has text - a control that
 * appears and disappears while typing is worse to aim at than one that reports an empty field.
 */
export function NotesSaveButton(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  const notes = useNotes(props.context)

  const save = () => notes.parkPrompt()

  return (
    <box
      id="notes-save-prompt"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.background.raised.base}
      onMouseUp={save}
    >
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        ⤓ save for later
      </text>
    </box>
  )
}
