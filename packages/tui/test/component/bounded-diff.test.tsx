/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiffRenderable, MouseButton, RGBA, type CliRenderer, type MouseEvent, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { BoundedDiff, isPlainClick } from "../../src/component/bounded-diff"
import { DIFF_PREVIEW_LIMITS } from "../../src/util/diff-preview"

const colors = {
  hunkFg: RGBA.fromHex("#7aa2f7"),
  lineNumberBg: RGBA.fromHex("#111111"),
}

function patch(file: string, lines: number) {
  return `--- a/${file}
+++ b/${file}
@@ -0,0 +1,${lines} @@
${Array.from({ length: lines }, (_, index) => `+new-${index}`).join("\n")}`
}

function findDiffs(node: Renderable): DiffRenderable[] {
  return node instanceof DiffRenderable ? [node] : node.getChildren().flatMap((child: Renderable) => findDiffs(child))
}

function renderText(node: Renderable): string {
  const text = (node as { plainText?: string }).plainText
  return [typeof text === "string" ? text : "", ...node.getChildren().map((child) => renderText(child))].join("\n")
}

async function render(diff: string, expandable = true) {
  return testRender(
    () => (
      <box width="100%" height="100%" flexDirection="column">
        <BoundedDiff {...colors} diff={diff} expandable={expandable} />
      </box>
    ),
    { width: 80, height: 20 },
  )
}

test("renders a small patch in the diff renderer", async () => {
  const small = patch("small.ts", 2)
  const app = await render(small)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root).map((item) => item.diff)).toEqual([small])
    expect(app.captureCharFrame()).not.toContain("Preview limited")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps a patch over the changed line limit out of the renderer until it is asked for", async () => {
  const large = patch("large.ts", DIFF_PREVIEW_LIMITS.maxChangedLines + 1)
  const app = await render(large)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])
    const frame = app.captureCharFrame()
    expect(frame).toContain("Preview limited")
    expect(frame).toContain("Click to render the full patch")

    await app.mockMouse.click(5, 1)
    await app.waitFor(() => findDiffs(app.renderer.root).length === 1)
    expect(findDiffs(app.renderer.root)[0]?.diff).toBe(large)
  } finally {
    app.renderer.destroy()
  }
})

test("bounds a patch by its UTF-8 bytes even when it has few lines", async () => {
  const large = `--- a/wide.ts\n+++ b/wide.ts\n@@ -1 +1 @@\n+${"x".repeat(DIFF_PREVIEW_LIMITS.maxPatchBytes)}`
  const app = await render(large)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])
    const bounded = renderText(app.renderer.root)
    expect(bounded).toContain("... diff omitted ...")
    // The whole patch never reaches the render tree: the summary is the preview budget plus two short notice lines.
    expect(bounded.length).toBeLessThan(DIFF_PREVIEW_LIMITS.maxPreviewCharacters + 256)
  } finally {
    app.renderer.destroy()
  }
})

test("shows the bounded summary without an expansion hint where the surface takes no pointer input", async () => {
  const large = patch("readonly.ts", DIFF_PREVIEW_LIMITS.maxChangedLines + 1)
  const app = await render(large, false)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])
    const frame = app.captureCharFrame()
    expect(frame).toContain("Preview limited")
    expect(frame).not.toContain("Click to render the full patch")

    await app.mockMouse.click(5, 1)
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("leaves the preview closed when the release ends a drag instead of a click", async () => {
  const large = patch("drag.ts", DIFF_PREVIEW_LIMITS.maxChangedLines + 1)
  const app = await render(large)
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])

    // A press, a move and a release is a copy gesture, not a click, even when it ends over the preview.
    await app.mockMouse.pressDown(2, 1)
    await app.mockMouse.moveTo(30, 3)
    await app.mockMouse.release(30, 3)
    await app.flush()
    expect(findDiffs(app.renderer.root)).toEqual([])

    await app.mockMouse.click(5, 1)
    await app.waitFor(() => findDiffs(app.renderer.root).length === 1)
  } finally {
    app.renderer.destroy()
  }
})

test("renders the full patch again when the input shrinks back under the limit", async () => {
  const large = patch("shrinks.ts", DIFF_PREVIEW_LIMITS.maxChangedLines + 1)
  const small = patch("shrinks.ts", 2)
  const [diff, setDiff] = createSignal(large)
  const app = await testRender(
    () => (
      <box width="100%" height="100%" flexDirection="column">
        <BoundedDiff {...colors} diff={diff()} expandable />
      </box>
    ),
    { width: 80, height: 20 },
  )
  try {
    await app.renderOnce()
    expect(findDiffs(app.renderer.root)).toEqual([])

    setDiff(small)
    await app.waitFor(() => findDiffs(app.renderer.root).length === 1)
    expect(findDiffs(app.renderer.root)[0]?.diff).toBe(small)
  } finally {
    app.renderer.destroy()
  }
})

function fakeRenderer(selection: unknown) {
  return { getSelection: () => selection } as unknown as CliRenderer
}

function release(button = MouseButton.LEFT) {
  return { button } as MouseEvent
}

test("counts a fresh cell selection as a click", () => {
  const fresh = { isStart: true, behavior: "cell", getSelectedText: () => "" }
  expect(isPlainClick(fakeRenderer(fresh), release())).toBe(true)
  expect(isPlainClick(fakeRenderer(undefined), release())).toBe(true)
})

test("refuses a release that ended a drag or a copy selection", () => {
  const moved = { isStart: false, behavior: "cell", getSelectedText: () => "copied text" }
  const selected = { isStart: true, behavior: "cell", getSelectedText: () => "a" }
  const line = { isStart: true, behavior: "line", getSelectedText: () => "" }

  expect(isPlainClick(fakeRenderer(moved), release())).toBe(false)
  expect(isPlainClick(fakeRenderer(selected), release())).toBe(false)
  expect(isPlainClick(fakeRenderer(line), release())).toBe(false)
  expect(isPlainClick(fakeRenderer(undefined), release(MouseButton.RIGHT))).toBe(false)
})
