import { StyledText, type RGBA, type TextRenderable } from "@opentui/core"
import { createEffect, createSignal } from "solid-js"
import { usePartialRender } from "./partial-render"

export function PartialText(props: {
  content: string | StyledText
  fg: RGBA
  width: number | `${number}%`
  truncate?: boolean
}) {
  const [element, setElement] = createSignal<TextRenderable>()
  const [width, setWidth] = createSignal(typeof props.width === "number" ? props.width : 0)
  usePartialRender(element)
  createEffect(() => {
    const renderable = element()
    if (!renderable) return
    const content = props.content
    const text = typeof content === "string" ? content : content.chunks.map((chunk) => chunk.text).join("")
    const padding = "\u00a0".repeat(Math.max(0, width() - Bun.stringWidth(text)))
    renderable.content =
      typeof content === "string"
        ? content.replaceAll(" ", "\u00a0") + padding
        : new StyledText([
            ...content.chunks.map((chunk) => ({ ...chunk, text: chunk.text.replaceAll(" ", "\u00a0") })),
            { __isChunk: true, text: padding },
          ])
  })

  // Dynamic JSX children invalidate the renderer root. Updating the renderable
  // itself preserves the partial-render source, while a fixed width keeps Yoga
  // clean so OpenTUI can safely redraw only this cell. Non-breaking spaces
  // overwrite stale transparent glyphs without painting a background.
  return (
    <text
      ref={setElement}
      content=""
      fg={props.fg}
      width={props.width}
      wrapMode="none"
      truncate={props.truncate}
      flexShrink={0}
      onSizeChange={() => {
        const renderable = element()
        if (renderable) setWidth(renderable.width)
      }}
    />
  )
}
