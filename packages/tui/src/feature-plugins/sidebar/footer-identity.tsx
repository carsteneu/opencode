/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

export function SidebarIdentity(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  return (
    <box gap={1}>
      <text fg={theme.text.muted}>
        <span style={{ fg: theme.text.feedback.success.base }}>•</span> <b>Open</b>
        <span style={{ fg: theme.text.base }}>
          <b>Code</b>
        </span>{" "}
        <span>{props.context.app.version}</span>
      </text>
      <text fg={theme.text.muted}>
        <span style={{ fg: theme.text.feedback.success.base }}>•</span> <span>{props.sessionID}</span>
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.footer.identity",
  setup(context) {
    // Append keeps the builtin footer (getting-started, working directory) intact.
    context.ui.slot({
      append: "sidebar.footer",
      render: (props) => <SidebarIdentity context={context} sessionID={props.sessionID} />,
    })
  },
})
