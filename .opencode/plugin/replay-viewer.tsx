// .opencode/plugin/replay-viewer.tsx
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

function ReplayViewer(props: { api: TuiPluginApi }) {
  return (
    <box padding={1}>
      <text fg="#888888">replay placeholder</text>
    </box>
  )
}

export default {
  id: "replay-viewer",
  tui(api: TuiPluginApi) {
    api.route.register([
      { name: "replay", render: () => <ReplayViewer api={api} /> },
    ])
    api.keymap.registerLayer({
      commands: [
        {
          name: "replay.open",
          title: "Open replay viewer",
          slashName: "replay",
          category: "VCS",
          namespace: "palette",
          run() {
            const current = api.route.current
            const sessionID = "params" in current ? current.params?.sessionID : undefined
            api.route.navigate("replay", { sessionID, returnRoute: current })
            api.ui.dialog.clear()
          },
        },
      ],
    })
  },
}
