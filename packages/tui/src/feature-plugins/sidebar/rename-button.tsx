import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { DialogSessionRename } from "../../component/dialog-session-rename"

const id = "internal:sidebar-rename"

function RenameButton(props: { api: TuiPluginApi; session_id: string }) {
  return (
    <box>
      <text
        fg={props.api.theme.current.textMuted}
        // Open on mouseup: the dialog backdrop closes on a subsequent mouseup, so
        // opening on mousedown would let the release hit the backdrop and dismiss it.
        onMouseUp={() => {
          props.api.ui.dialog.replace(() => <DialogSessionRename session={props.session_id} />)
        }}
      >
        ✎
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_title_actions(_ctx, props) {
        return <RenameButton api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
