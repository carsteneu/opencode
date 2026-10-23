/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiffRenderable, RGBA, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { BoundedDiff } from "../../src/component/bounded-diff"
import { DIFF_PREVIEW_LIMITS } from "../../src/util/diff-preview"

const colors = { hunkFg: RGBA.fromHex("#7aa2f7"), lineNumberBg: RGBA.fromHex("#111111") }

function patch(file: string, lines: number) {
  return `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `+new-${index}`).join("\n")}`
}

function findDiffs(node: Renderable): DiffRenderable[] {
  return node instanceof DiffRenderable ? [node] : node.getChildren().flatMap((child: Renderable) => findDiffs(child))
}

test("PROBE: drag-selecting the preview must not mount the full patch", async () => {
  const large = patch("large.ts", DIFF_PREVIEW_LIMITS.maxChangedLines + 1)
  const app = await testRender(
    () => (
      <box width="100%" height="100%" flexDirection="column">
        <BoundedDiff {...colors} diff={large} expandable />
      </box>
    ),
    { width: 80, height: 20 },
  )
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])
    await app.mockMouse.drag(2, 1, 40, 3)
    await app.flush()
    console.log("selection:", JSON.stringify(app.renderer.getSelection()?.getSelectedText() ?? null))
    console.log("mounted after drag:", findDiffs(app.renderer.root).length)
    expect(findDiffs(app.renderer.root)).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
