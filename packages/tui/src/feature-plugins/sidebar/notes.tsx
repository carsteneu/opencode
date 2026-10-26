/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NotesRuntime, SidebarNotes } from "../../component/sidebar-notes"

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
  },
})
