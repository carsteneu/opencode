/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiffRenderable, RGBA, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ApplyPatchSummary } from "../../src/component/apply-patch-summary"
import { DIFF_PREVIEW_LIMITS, measureDiff } from "../../src/util/diff-preview"

const colors = { fg: RGBA.fromHex("#ffffff"), mutedFg: RGBA.fromHex("#888888") }

function patch(file: string, lines: number) {
  return `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${Array.from(
    { length: lines },
    (_, index) => `+${file}-${index}`,
  ).join("\n")}`
}

function files(count: number, lines: number) {
  return Array.from({ length: count }, (_, index) => {
    const value = patch(`file-${index}.ts`, lines)
    return { relativePath: `file-${index}.ts`, patch: value, additions: lines, deletions: 0 }
  })
}

function findDiffs(node: Renderable): DiffRenderable[] {
  return node instanceof DiffRenderable ? [node] : node.getChildren().flatMap((child) => findDiffs(child))
}

function renderText(node: Renderable): string {
  const text = (node as { plainText?: string }).plainText
  return [typeof text === "string" ? text : "", ...node.getChildren().map((child) => renderText(child))].join("\n")
}

async function render(input: ReturnType<typeof files>) {
  return testRender(
    () => (
      <box width="100%" height="100%" flexDirection="column">
        <ApplyPatchSummary
          {...colors}
          files={input}
          measured={input.map((file) => measureDiff(file.patch))}
          formatPath={(value) => value}
        />
      </box>
    ),
    { width: 80, height: 30 },
  )
}

test("lists a large set without mounting a single patch", async () => {
  const input = files(DIFF_PREVIEW_LIMITS.maxSetFiles + 1, 4)
  const app = await render(input)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toHaveLength(0)
    const frame = app.captureCharFrame()
    expect(frame).toContain("file-0.ts +4 -0")
    expect(frame).toContain("file-19.ts +4 -0")
    expect(frame).toContain("+1 more files")
    expect(frame).toContain("Open the diff viewer for the full review.")
  } finally {
    app.renderer.destroy()
  }
})

test("bounds the preview text of a set too large to show", async () => {
  const input = files(3, DIFF_PREVIEW_LIMITS.maxChangedLines)
  const app = await render(input)
  try {
    await app.renderOnce()
    const bounded = renderText(app.renderer.root)
    expect(bounded).toContain("... diff omitted ...")
    expect(bounded.length).toBeLessThan(DIFF_PREVIEW_LIMITS.maxPreviewCharacters + 256)
  } finally {
    app.renderer.destroy()
  }
})
