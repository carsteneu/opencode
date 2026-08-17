/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DiffRenderable, type Renderable, type TerminalColors, TextRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { JSX } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { parseApplyPatchFiles, SessionApplyPatchOutput, SessionEditOutput } from "../../../src/routes/session"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencode-session-diff-"))
  await mkdir(path.join(root, "state"))
  await Bun.write(path.join(root, "state", "kv.json"), "{}")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("session diff output", () => {
  test("keeps a small edit in the diff renderer", async () => {
    const patch = createPatch("small.ts", 1)
    const app = await render(() => (
      <SessionEditOutput title="← Edit small.ts" diff={patch} filePath="small.ts" view="unified" wrapMode="word" />
    ))

    try {
      expect(findDiffs(app.renderer.root).map((item) => item.diff)).toEqual([patch])
    } finally {
      app.renderer.destroy()
    }
  })

  test("bounds a large edit until the user clicks for its exact diff", async () => {
    const patch = createPatch("large.ts", 260)
    const app = await render(() => (
      <SessionEditOutput title="← Edit large.ts" diff={patch} filePath="large.ts" view="unified" wrapMode="word" />
    ))

    try {
      expect(findDiffs(app.renderer.root)).toHaveLength(0)
      expect(text(app.renderer.root)).toContain("/diff opens the full review")

      await app.mockMouse.click(5, 2)
      await app.flush()

      expect(findDiffs(app.renderer.root).map((item) => item.diff)).toEqual([patch])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps every small apply-patch file in its own diff renderer", async () => {
    const files = applyPatchFiles(2, 1)
    const app = await render(() => (
      <SessionApplyPatchOutput files={files} view="unified" wrapMode="word" formatPath={(value) => value} />
    ))

    try {
      expect(findDiffs(app.renderer.root).map((item) => item.diff)).toEqual(
        files.map((file) => file.patch).filter((patch): patch is string => patch !== undefined),
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders patchless apply-patch files as a non-expandable statistics summary", async () => {
    const files = parseApplyPatchFiles([
      {
        type: "update",
        relativePath: "first.ts",
        filePath: "/repo/first.ts",
        additions: 2,
        deletions: 1,
      },
      {
        type: "add",
        relativePath: "second.ts",
        filePath: "/repo/second.ts",
        additions: 3,
        deletions: 0,
      },
    ])
    const app = await render(() => (
      <SessionApplyPatchOutput files={files} view="unified" wrapMode="word" formatPath={(value) => value} />
    ))

    try {
      expect(findDiffs(app.renderer.root)).toHaveLength(0)
      expect(text(app.renderer.root)).toContain("# Patched 2 files · +5 -1")
      expect(text(app.renderer.root)).toContain("first.ts +2 -1")
      expect(text(app.renderer.root)).toContain("second.ts +3 -0")
      expect(text(app.renderer.root)).not.toContain("Click to show full patch")
    } finally {
      app.renderer.destroy()
    }
  })

  test("bounds apply-patch output when a single file has a large patch", async () => {
    const files = applyPatchFiles(1, 260)
    const app = await render(() => (
      <SessionApplyPatchOutput files={files} view="unified" wrapMode="word" formatPath={(value) => value} />
    ))

    try {
      expect(findDiffs(app.renderer.root)).toHaveLength(0)
      expect(text(app.renderer.root)).toContain("# Patched 1 file")
      expect(text(app.renderer.root)).toContain("Click to show full patch")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders one bounded aggregate for many files and expands to one exact raw patch", async () => {
    const files = applyPatchFiles(21, 10)
    const lastMarker = "+new-20-9"
    const app = await render(() => (
      <SessionApplyPatchOutput
        files={files}
        diagnostics={{
          "/repo/file-20.ts": [
            { severity: 1, message: "aggregate diagnostic", range: { start: { line: 2, character: 3 } } },
          ],
        }}
        view="unified"
        wrapMode="word"
        formatPath={(value) => value}
      />
    ))

    try {
      expect(findDiffs(app.renderer.root)).toHaveLength(0)
      expect(text(app.renderer.root)).toContain("file-0.ts +10 -10")
      expect(text(app.renderer.root)).toContain("+1 more files")
      expect(text(app.renderer.root)).not.toContain(lastMarker)
      expect(text(app.renderer.root)).toContain("aggregate diagnostic")

      await app.mockMouse.click(5, 2)
      await app.flush()

      expect(findDiffs(app.renderer.root)).toHaveLength(0)
      expect(
        findTexts(app.renderer.root).some((item) => item.plainText === files.map((file) => file.patch).join("\n")),
      ).toBe(true)
      expect(text(app.renderer.root)).toContain(lastMarker)
      expect(text(app.renderer.root)).toContain("aggregate diagnostic")
      expect(text(app.renderer.root)).toContain("Click to collapse")
    } finally {
      app.renderer.destroy()
    }
  })
})

async function render(component: () => JSX.Element) {
  const app = await testRender(() => <Harness component={component} />, { width: 80, height: 60 })
  const started = performance.now()
  while (text(app.renderer.root).length === 0 && findDiffs(app.renderer.root).length === 0) {
    if (performance.now() - started > 2_000) throw new Error("Timed out mounting the session diff")
    await Bun.sleep(10)
    await app.renderOnce()
  }
  return app
}

function Harness(props: { component: () => JSX.Element }) {
  const renderer = useRenderer()
  renderer.getPalette = async () =>
    ({
      palette: [],
      defaultForeground: null,
      defaultBackground: null,
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightBackground: null,
      highlightForeground: null,
    }) satisfies TerminalColors
  return (
    <TestTuiContexts directory={root} paths={{ state: path.join(root, "state") }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            {props.component()}
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function findDiffs(root: Renderable): DiffRenderable[] {
  if (root instanceof DiffRenderable) return [root]
  return root.getChildren().flatMap(findDiffs)
}

function text(root: Renderable): string {
  return findTexts(root)
    .map((item) => item.plainText)
    .join("\n")
}

function findTexts(root: Renderable): TextRenderable[] {
  if (root instanceof TextRenderable) return [root]
  return root.getChildren().flatMap(findTexts)
}

function applyPatchFiles(count: number, changes: number) {
  return parseApplyPatchFiles(
    Array.from({ length: count }, (_, index) => ({
      type: "update",
      relativePath: `file-${index}.ts`,
      filePath: `/repo/file-${index}.ts`,
      patch: createPatch(`file-${index}.ts`, changes, index),
      deletions: changes,
    })),
  )
}

function createPatch(file: string, changes: number, fileIndex = 0) {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${changes} +1,${changes} @@`,
    ...Array.from({ length: changes }, (_, index) => [
      `-old-${fileIndex}-${index}`,
      `+new-${fileIndex}-${index}`,
    ]).flat(),
  ].join("\n")
}
