/** @jsxImportSource @opentui/solid */
import type { ColorInput } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { DIFF_PREVIEW_LIMITS, createDiffPreview } from "../util/diff-preview"

type Props = {
  files: readonly {
    readonly relativePath: string
    readonly patch: string
    readonly additions: number
    readonly deletions: number
  }[]
  /** Per-patch measurements, in the same order as `files`. */
  measured: readonly { readonly additions: number; readonly deletions: number }[]
  fg: ColorInput
  mutedFg: ColorInput
  formatPath: (value: string) => string
}

/**
 * The whole-set summary of an apply-patch result. It lists what changed and shows a bounded preview, but never
 * mounts a patch: the review itself belongs to the diff viewer.
 */
export function ApplyPatchSummary(props: Props) {
  const preview = createMemo(() =>
    createDiffPreview(
      props.files
        .slice(0, DIFF_PREVIEW_LIMITS.maxSetFiles)
        .map((file) => createDiffPreview(file.patch).preview)
        .join("\n"),
    ),
  )

  return (
    <box gap={1} flexDirection="column">
      <box flexDirection="column" flexShrink={0}>
        <For each={props.measured.slice(0, DIFF_PREVIEW_LIMITS.maxSetFiles)}>
          {(item, index) => (
            <text fg={props.mutedFg} flexShrink={0} wrapMode="none" truncate>
              {props.formatPath(props.files[index()]!.relativePath)} +{item.additions} -{item.deletions}
            </text>
          )}
        </For>
        <Show when={props.files.length > DIFF_PREVIEW_LIMITS.maxSetFiles}>
          <text fg={props.mutedFg} flexShrink={0}>
            +{props.files.length - DIFF_PREVIEW_LIMITS.maxSetFiles} more files
          </text>
        </Show>
      </box>
      <text fg={props.fg} wrapMode="char">
        {preview().preview}
      </text>
      <text fg={props.mutedFg} flexShrink={0}>
        Open the diff viewer for the full review.
      </text>
    </box>
  )
}
