/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NotesRuntime, SidebarNotes } from "../../component/sidebar-notes"
import { NotesSaveButton } from "../../component/prompt-notes-save"

export default Plugin.define({
  id: "opencode.sidebar.notes",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarNotes context={context} sessionID={props.sessionID} />,
    })

    // Mounted on the app slot rather than inside the sidebar: the block disappears when the sidebar is
    // closed or too narrow, but the commands and the answer capture must not.
    context.ui.slot({ append: "app", render: () => <NotesRuntime context={context} /> })

    // The composer's other exit: park the typed prompt as a note instead of sending it.
    context.ui.slot({ append: "prompt.footer", render: () => <NotesSaveButton context={context} /> })
  },
})
