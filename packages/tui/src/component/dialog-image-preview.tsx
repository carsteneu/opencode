import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import type { SessionImage } from "../util/session-image"
import { SessionNativeImage, supportsNativeImages } from "./native-image"

export function DialogImagePreview(props: { images: readonly SessionImage[]; initial: number }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const [failed, setFailed] = createSignal(false)
  const currentIndex = createMemo(() => Math.max(0, Math.min(props.images.length - 1, index())))
  const current = createMemo(() => props.images[currentIndex()])
  const height = createMemo(() => Math.max(3, dimensions().height - Math.floor(dimensions().height / 4) - 5))
  const supported = supportsNativeImages()

  dialog.setSize("xlarge")

  createEffect(
    on(
      () => current()?.uri,
      () => setFailed(false),
    ),
  )

  const move = (direction: number) => {
    if (props.images.length < 2) return
    setFailed(false)
    setIndex((currentIndex() + direction + props.images.length) % props.images.length)
  }

  useBindings(() => ({
    bindings: [
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
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
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
              fit="fit"
              protocol="auto"
              width="100%"
              height={height()}
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
