import { useTerminalDimensions } from "@opentui/solid"
import path from "node:path"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { abbreviateHome } from "../runtime"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { resolveSessionImageDirectory, saveSessionImage } from "../util/session-image-save"

type ImagePreviewItem = Readonly<{
  uri: string
  mention?: Readonly<{ text: string }>
}>

export function DialogImagePreview(props: { images: readonly ImagePreviewItem[]; initial: number }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const theme = useTheme().surface("dialog")
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const [failed, setFailed] = createSignal(false)
  const current = createMemo(() => props.images[index()])
  const imageHeight = createMemo(() => Math.max(3, dimensions().height - 8))
  const saveShortcut = Keymap.useShortcut("dialog.image.save")

  dialog.setSize("xlarge")
  dialog.setCentered(true)

  function move(direction: number) {
    if (props.images.length < 2) return
    setFailed(false)
    setIndex((value) => (value + direction + props.images.length) % props.images.length)
  }

  function save() {
    const image = current()
    if (image) dialog.replace(() => <DialogImageSave image={image} />)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    // A modal dialog must beat the global layers of whatever opened it (the diff viewer binds `s` too).
    priority: 1,
    commands: [
      { bind: "left", title: "Previous image", group: "Dialog", run: () => move(-1) },
      { bind: "right", title: "Next image", group: "Dialog", run: () => move(1) },
      { id: "dialog.image.save", bind: "s", title: "Save image", group: "Dialog", run: save },
    ],
  }))

  return (
    <DialogLayout
      id="prompt-image-viewer"
      header={<DialogHeader title={`Image ${index() + 1} of ${props.images.length}`} />}
      footer={{
        actions: {
          primary:
            props.images.length > 1
              ? [
                  { title: "previous", key: "←", onTrigger: () => move(-1) },
                  { title: "next", key: "→", onTrigger: () => move(1) },
                  { title: "save", key: "s", onTrigger: save },
                ]
              : [{ title: "save", key: "s", onTrigger: save }],
        },
        get children() {
          return (
            <text fg={failed() ? theme.text.feedback.error.base : theme.text.muted} wrapMode="none" truncate>
              {failed() ? "No preview" : (current().mention?.text ?? `Image ${index() + 1}`)}
            </text>
          )
        },
      }}
      legacyFooter={
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
          <text fg={theme.text.muted} onMouseUp={save}>
            {saveShortcut() ? `${saveShortcut()} save` : "save"}
          </text>
        </box>
      }
    >

      <image
        id="prompt-image-viewer-image"
        source={current().uri}
        fit="fit"
        protocol="auto"
        width="100%"
        height={imageHeight()}
        onError={() => setFailed(true)}
      />
    </DialogLayout>
  )
}

function DialogImageSave(props: { image: ImagePreviewItem }) {
  const dialog = useDialog()
  const toast = useToast()
  const paths = useTuiPaths()
  const theme = useTheme().surface("dialog")
  const [saving, setSaving] = createSignal(false)
  let closed = false

  onCleanup(() => {
    closed = true
  })

  function save(input: string) {
    if (saving()) return
    const directory = resolveSessionImageDirectory(input, paths)
    if (directory === undefined) {
      toast.error(new Error("Image save directory is required"))
      return
    }
    setSaving(true)
    void Promise.resolve()
      .then(() => saveSessionImage(props.image.uri, directory, props.image.mention?.text))
      .then(
        (target) => {
          if (closed) return
          toast.show({
            message: `Saved ${path.basename(target)} to ${abbreviateHome(target, paths.home)}`,
            variant: "success",
          })
          dialog.clear()
        },
        (error) => {
          if (closed) return
          toast.error(error)
          setSaving(false)
        },
      )
  }

  // `paths.cwd` is the working tree, so the default must not drop downloads into it.
  const saveDirectory = () => path.join(paths.home, "Downloads")

  return (
    <DialogPrompt
      title="Save image"
      value={saveDirectory()}
      busy={saving()}
      busyText="Saving image..."
      description={() => (
        <text fg={theme.text.muted}>
          Directory. {abbreviateHome(saveDirectory(), paths.home)} by default; relative paths resolve against{" "}
          {abbreviateHome(paths.cwd, paths.home)}. The filename is generated automatically.
        </text>
      )}
      onConfirm={save}
    />
  )
}
