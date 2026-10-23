/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiffRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RunPermissionBody } from "../../src/mini/footer.permission"
import { RUN_THEME_FALLBACK } from "../../src/mini/theme"
import type { MiniPermissionRequest } from "../../src/mini/types"
import { DIFF_PREVIEW_LIMITS } from "../../src/util/diff-preview"

function patchFile(file: string, lines: number) {
  return `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${Array.from(
    { length: lines },
    (_, index) => `+${file}-${index}`,
  ).join("\n")}`
}

function request(id: string, file: string, lines: number): MiniPermissionRequest {
  return {
    id,
    sessionID: "session-1",
    action: "edit",
    resources: [`/project/src/${file}`],
    metadata: { files: [{ file: `/project/src/${file}`, patch: patchFile(file, lines) }] },
  } as MiniPermissionRequest
}

const large = DIFF_PREVIEW_LIMITS.maxChangedLines + 1

function renderText(node: Renderable): string {
  const text = (node as { plainText?: string }).plainText
  return [typeof text === "string" ? text : "", ...node.getChildren().map((child) => renderText(child))].join("\n")
}

function findDiffs(node: Renderable): DiffRenderable[] {
  return node instanceof DiffRenderable ? [node] : node.getChildren().flatMap((child) => findDiffs(child))
}

test("bounds a patch that mono mode folds into a plain line", async () => {
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={request("mono", "large.ts", large)}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={() => {}}
        mono
      />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Preview limited")
    expect(renderText(app.renderer.root)).not.toContain("large.ts-600")
  } finally {
    app.renderer.destroy()
  }
})

test("does not carry a preview expansion over to the next queued permission", async () => {
  const [pending, setPending] = createSignal(request("first", "first.ts", large))
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={pending()}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={() => {}}
      />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.renderOnce()
    const preview = app.renderer.root.findDescendantById("diff-preview-limited")!
    await app.mockMouse.click(preview.x + 2, preview.y + 1)
    await app.flush()
    expect(findDiffs(app.renderer.root)).toHaveLength(1)

    // The body is replaced in place, so the expansion must be keyed by request.
    setPending(request("second", "second.ts", large))
    await app.flush()
    await app.renderOnce()
    expect(renderText(app.renderer.root)).toContain("Preview limited")
    expect(findDiffs(app.renderer.root)).toHaveLength(0)
    expect(renderText(app.renderer.root)).not.toContain("second.ts-600")
  } finally {
    app.renderer.destroy()
  }
})

test("leaves a permission patch under the limits untouched", async () => {
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={request("small", "small.ts", 3)}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={() => {}}
      />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Preview limited")
    expect(findDiffs(app.renderer.root)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
