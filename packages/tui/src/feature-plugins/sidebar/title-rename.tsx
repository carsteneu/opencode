/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

export function SessionRenamePencil(props: { context: Plugin.Context; sessionID: string; title: string }) {
  const rename = async () => {
    const value = await props.context.ui.dialog.prompt({
      title: "Rename session",
      placeholder: "Session title",
      value: props.title,
    })
    if (value === undefined) return
    const title = value.trim()
    if (!title) return
    await props.context.client.session.update({ sessionID: props.sessionID, title }).catch((error: unknown) =>
      props.context.ui.toast.show({
        message: `Failed to rename session: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
        duration: 5000,
      }),
    )
  }
  return (
    <box id="sidebar.title.rename" flexShrink={0} onMouseUp={() => void rename()}>
      <text fg={props.context.theme.text.muted}>✎</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.title.rename",
  setup(context) {
    context.ui.slot({
      append: "sidebar.title.actions",
      render: (props) => <SessionRenamePencil context={context} sessionID={props.sessionID} title={props.title} />,
    })
  },
})
