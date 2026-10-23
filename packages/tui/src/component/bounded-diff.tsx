/** @jsxImportSource @opentui/solid */
import type { ColorInput } from "@opentui/core"
import { createMemo, createSignal, Show, splitProps, type Accessor } from "solid-js"
import { createDiffPreview, formatDiffBytes } from "../util/diff-preview"
import { PatchDiff, type PatchDiffProps } from "./patch-diff"

type Props = PatchDiffProps & {
  /** Colors for the summary notice and its preview; the call site owns the palette. */
  noticeFg?: ColorInput
  previewFg?: ColorInput
  /** Offers the full patch on demand. Omitted where the surface takes no pointer input. */
  expandable?: boolean
  /** Lets the call site own the expansion, so it survives a remount; otherwise it is local. */
  expanded?: Accessor<boolean>
  onExpand?: () => void
}

/**
 * Renders a patch, or a bounded head and tail summary of one too large to mount. The summary is a plain preview,
 * never a partial patch: an oversized patch is either rendered whole or not at all.
 */
export function BoundedDiff(props: Props) {
  const [local, diffProps] = splitProps(props, ["noticeFg", "previewFg", "expandable", "expanded", "onExpand"])
  const [ownExpanded, setOwnExpanded] = createSignal(false)
  const expanded = () => local.expanded?.() ?? ownExpanded()
  const preview = createMemo(() => createDiffPreview(diffProps.diff))

  return (
    <Show
      when={!preview().limited || expanded()}
      fallback={
        <box
          id="diff-preview-limited"
          flexDirection="column"
          gap={1}
          onMouseUp={(event) => {
            if (!local.expandable) return
            event.stopPropagation()
            if (local.onExpand) local.onExpand()
            else setOwnExpanded(true)
          }}
        >
          <text fg={local.noticeFg} selectable={false}>
            {`Preview limited (${formatDiffBytes(preview().bytes)}, ${preview().changedLines} changed lines)`}
          </text>
          <text fg={local.previewFg} wrapMode="char">
            {preview().preview}
          </text>
          <Show when={local.expandable}>
            <text fg={local.noticeFg} selectable={false}>
              Click to render the full patch.
            </text>
          </Show>
        </box>
      }
    >
      <PatchDiff {...diffProps} />
    </Show>
  )
}
