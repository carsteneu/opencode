import { Show, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import { type RGBA, type Renderable } from "@opentui/core"
import { registerOpencodeSpinner } from "./register-spinner"
import { usePartialRender } from "../ui/partial-render"

registerOpencodeSpinner()

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const [spinnerEl, setSpinnerEl] = createSignal<Renderable | undefined>(undefined)
  // Spinner animation ticks (via the underlying SpinnerRenderable's own
  // scheduler) route through the partial-render fast path when no dialog is
  // open, avoiding a full tree render per frame.
  usePartialRender(spinnerEl)
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner ref={setSpinnerEl} frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
