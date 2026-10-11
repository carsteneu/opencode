import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import path from "node:path"
import { createMemo, createSignal } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { abbreviateHome } from "../util/path-format"
import { saveSessionImage } from "../util/session-image-save"

type ImagePreviewItem = Readonly<{
  uri: string
  mention?: Readonly<{ text: string }>
}>

export function DialogImagePreview(props: { images: readonly ImagePreviewItem[]; initial: number }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const shortcuts = Keymap.useShortcuts()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const [failed, setFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const current = createMemo(() => props.images[index()])
  const imageHeight = createMemo(() => Math.max(3, dimensions().height - 8))

  dialog.setSize("xlarge")
  dialog.setCentered(true)

  function move(direction: number) {
    if (props.images.length < 2) return
    setFailed(false)
    setIndex((value) => (value + direction + props.images.length) % props.images.length)
  }

  function save() {
    const image = current()
    if (!image || saving()) return
    setSaving(true)
    void saveSessionImage(image.uri, path.join(paths.home, "Downloads"), image.mention?.text)
      .then(
        (target) => toast.show({ message: `Saved image to ${abbreviateHome(target, paths.home)}`, variant: "success" }),
        (error) => toast.error(error),
      )
      .finally(() => setSaving(false))
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "left", title: "Previous image", group: "Dialog", run: () => move(-1) },
      { bind: "right", title: "Next image", group: "Dialog", run: () => move(1) },
      { id: "dialog.image.save", title: "Save image", group: "Dialog", run: save },
    ],
  }))

  return (
    <box id="prompt-image-viewer" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Image {index() + 1} of {props.images.length}
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={saving() ? theme.text.muted : theme.text.base} onMouseUp={save}>
            {saving() ? "saving…" : `${shortcuts.get("dialog.image.save") ?? "click"} save`}
          </text>
          <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <image
        id="prompt-image-viewer-image"
        source={current().uri}
        fit="fit"
        protocol="auto"
        width="100%"
        height={imageHeight()}
        onError={() => setFailed(true)}
      />
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.muted} onMouseUp={() => move(-1)}>
          {props.images.length > 1 ? "← previous" : ""}
        </text>
        <text fg={failed() ? theme.text.feedback.error.base : theme.text.muted} wrapMode="none" truncate>
          {failed() ? "No preview" : (current().mention?.text ?? `Image ${index() + 1}`)}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => move(1)}>
          {props.images.length > 1 ? "next →" : ""}
        </text>
      </box>
    </box>
  )
}
