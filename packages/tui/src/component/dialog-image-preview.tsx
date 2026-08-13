import { TextAttributes } from "@opentui/core"
import path from "node:path"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { useTuiPaths } from "../context/runtime"
import { useBindings, useCommandShortcut } from "../keymap"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import type { SessionImage } from "../util/session-image"
import { saveSessionImage } from "../util/session-image-save"
import type { SessionImageSourceAcquirer, SessionImageSourceReader } from "../util/session-image-source"
import { SessionNativeImage, supportsNativeImages } from "./native-image"

const MAX_DIALOG_SESSION_IMAGE_PIXELS = 8 * 1024 * 1024

export function DialogImagePreview(props: {
  images: readonly SessionImage[]
  initial: number
  loadSource?: SessionImageSourceReader
  acquireSource?: SessionImageSourceAcquirer
}) {
  const dialog = useDialog()
  const toast = useToast()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const [failed, setFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [source, setSource] = createSignal<{ uri: string; data: Uint8Array }>()
  const currentIndex = createMemo(() => Math.max(0, Math.min(props.images.length - 1, index())))
  const current = createMemo(() => props.images[currentIndex()])
  const height = createMemo(() => Math.max(3, dimensions().height - Math.floor(dimensions().height / 4) - 5))
  const supported = supportsNativeImages()
  const saveShortcut = useCommandShortcut("dialog.image.save")
  let saveController: AbortController | undefined

  dialog.setSize("xlarge")

  createEffect(
    on(
      () => current()?.uri,
      () => {
        setFailed(false)
        setSource(undefined)
      },
    ),
  )

  const move = (direction: number) => {
    if (props.images.length < 2) return
    setFailed(false)
    setIndex((currentIndex() + direction + props.images.length) % props.images.length)
  }

  const save = () => {
    const image = current()
    if (!image || saving()) return
    saveController?.abort()
    const controller = new AbortController()
    saveController = controller
    setSaving(true)
    const loaded = source()
    void saveSessionImage(
      image,
      path.join(paths.home, "Downloads"),
      controller.signal,
      loaded?.uri === image.uri ? loaded.data : undefined,
      props.loadSource,
    )
      .then(
        (target) => {
          if (controller.signal.aborted) return
          const display = target.startsWith(paths.home + path.sep) ? `~${target.slice(paths.home.length)}` : target
          toast.show({ message: `Saved image to ${display}`, variant: "success" })
        },
        (error) => {
          if (controller.signal.aborted) return
          toast.error(error)
        },
      )
      .finally(() => {
        if (saveController !== controller) return
        saveController = undefined
        setSaving(false)
      })
  }

  onCleanup(() => saveController?.abort())

  useBindings(() => ({
    priority: 1,
    commands: [{ name: "dialog.image.save", title: "Save image", category: "Dialog", run: save }],
    bindings: [
      ...tuiConfig.keybinds.gather("dialog.image", ["dialog.image.save"]),
      { key: "left", desc: "Previous image", group: "Dialog", cmd: () => move(-1) },
      { key: "right", desc: "Next image", group: "Dialog", cmd: () => move(1) },
    ],
  }))

  return (
    <Show when={current()}>
      {(image) => (
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Image {currentIndex() + 1} of {props.images.length}
            </text>
            <box flexDirection="row" gap={2}>
              <text fg={saving() ? theme.textMuted : theme.text} onMouseUp={save}>
                {saving() ? "saving..." : `${saveShortcut() || "click"} save`}
              </text>
              <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
                esc
              </text>
            </box>
          </box>
          <Show
            when={supported && !failed()}
            fallback={
              <box height={height()} alignItems="center" justifyContent="center">
                <text fg={theme.textMuted}>Preview unavailable</text>
              </box>
            }
          >
            <SessionNativeImage
              source={image().uri}
              load={props.acquireSource}
              fit="fit"
              protocol="auto"
              width="100%"
              height={height()}
              maxPixels={MAX_DIALOG_SESSION_IMAGE_PIXELS}
              onSource={(source) => setSource(source ? { uri: image().uri, data: source.data } : undefined)}
              onError={() => setFailed(true)}
            />
          </Show>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.textMuted} onMouseUp={() => move(-1)}>
              {props.images.length > 1 ? "← previous" : ""}
            </text>
            <text fg={failed() ? theme.error : theme.textMuted} wrapMode="none" truncate>
              {image().label}
            </text>
            <text fg={theme.textMuted} onMouseUp={() => move(1)}>
              {props.images.length > 1 ? "next →" : ""}
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}
