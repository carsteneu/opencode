/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { DiffRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { TuiKeybind } from "../../../src/config/keybind"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import { DIFF_PREVIEW_LIMITS } from "../../../src/util/diff-preview"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencode-diff-viewer-"))
  await mkdir(path.join(root, "state"))
  await Bun.write(path.join(root, "state", "kv.json"), "{}")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

test("closing the diff viewer returns to the route it opened from", async () => {
  const viewer = await renderDiffViewer([])
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "git", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "git", context: 12 })

    expect(viewer.commands.has("diff.close")).toBe(true)
    viewer.commands.get("diff.close")!.run?.({} as never)
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("brackets navigate diff hunks", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "src/file.ts",
        additions: 3,
        deletions: 3,
        status: "modified",
        patch: `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldFirst = true
+const newFirst = true
 const afterFirst = true
@@ -20,3 +20,3 @@
 const second = true
-const oldSecond = true
+const newSecond = true
 const afterSecond = true
@@ -40,3 +40,3 @@
 const third = true
-const oldThird = true
+const newThird = true
 const afterThird = true`,
      },
    ],
    12,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("const first"))
    await viewer.app.waitFor(() => Boolean(findScrollBox(viewer.app.renderer.root)))
    await viewer.app.flush()
    const scroll = findScrollBox(viewer.app.renderer.root)!
    const initial = scroll.scrollTop

    expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("]")
    expect(TuiKeybind.defaultValue("diff_previous_hunk")).toBe("[")

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const first = scroll.scrollTop
    expect(first).toBeGreaterThan(initial)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const second = scroll.scrollTop
    expect(second).toBeGreaterThan(first)

    viewer.commands.get("diff.previous_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(second)

    scroll.scrollTo(initial)
    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("small diff sets still render every patch", async () => {
  const diffs = [diffFile("src/one.ts"), diffFile("src/two.ts")]
  const viewer = await renderDiffViewer(diffs)
  try {
    await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root).length === diffs.length)
    expect(findDiffs(viewer.app.renderer.root).map((node) => node.diff)).toEqual(diffs.map((item) => item.patch))
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("large diff sets automatically mount at most one patch without changing the KV preference", async () => {
  const cases = [
    Array.from({ length: DIFF_PREVIEW_LIMITS.maxSetFiles + 1 }, (_, index) => diffFile(`src/file-${index}.ts`)),
    Array.from({ length: 3 }, (_, index) =>
      diffFile(`src/aggregate-${index}.ts`, paddedPatch(`src/aggregate-${index}.ts`, 90 * 1024)),
    ),
  ]

  for (const diffs of cases) {
    const viewer = await renderDiffViewer(diffs, 20, undefined, { diff_viewer_single_patch: false })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Safe mode: one patch at a time"))
      expect(findDiffs(viewer.app.renderer.root).length).toBeLessThanOrEqual(1)
      expect(viewer.kvValue("diff_viewer_single_patch")).toBe(false)
      expect(viewer.kvWrites()).toEqual([])

      void viewer.commands.get("diff.single_patch")!.run?.({} as never)
      await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root).length > 1)
      expect(viewer.app.captureCharFrame()).not.toContain("Safe mode: one patch at a time")
    } finally {
      viewer.app.renderer.destroy()
    }
  }
})

test("automatic single-patch navigation destroys the previous renderable", async () => {
  const diffs = Array.from({ length: DIFF_PREVIEW_LIMITS.maxSetFiles + 1 }, (_, index) =>
    diffFile(`src/file-${index}.ts`),
  )
  const viewer = await renderDiffViewer(diffs)
  try {
    await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root).length === 1)
    void viewer.commands.get("diff.next_file")!.run?.({} as never)
    await viewer.app.renderOnce()
    const previous: DiffRenderable[] = []
    for (let index = 0; index < 5; index++) {
      const node = findDiffs(viewer.app.renderer.root)[0]!
      previous.push(node)
      void viewer.commands.get("diff.next_file")!.run?.({} as never)
      await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root)[0] !== node)
    }

    expect(previous.every((node) => node.isDestroyed)).toBe(true)
    expect(findDiffs(viewer.app.renderer.root)).toHaveLength(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("large individual patches stay raw until explicitly expanded", async () => {
  const patch = paddedPatch("src/large.ts", DIFF_PREVIEW_LIMITS.maxPatchBytes + 1024)
  const viewer = await renderDiffViewer([diffFile("src/large.ts", patch)])
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("Press Enter or Space to render the full"))
    expect(findDiffs(viewer.app.renderer.root)).toHaveLength(0)

    void viewer.commands.get("diff.toggle")!.run?.({} as never)
    await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root).length === 1)
    const node = findDiffs(viewer.app.renderer.root)[0]
    expect(node.diff).toBe(patch)

    void viewer.commands.get("diff.toggle")!.run?.({} as never)
    await viewer.app.waitFor(() => findDiffs(viewer.app.renderer.root).length === 0)
    expect(node.isDestroyed).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("very large file sets initially hide the tree and explicit toggle does not overwrite KV", async () => {
  const diffs = Array.from({ length: DIFF_PREVIEW_LIMITS.maxFileTreeFiles + 1 }, (_, index) =>
    diffFile(`src/file-${String(index).padStart(3, "0")}.ts`),
  )
  const viewer = await renderDiffViewer(diffs, 20, undefined, { diff_viewer_show_file_tree: true })
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("Safe mode: one patch at a time"))
    const initialScrollBoxes = findScrollBoxes(viewer.app.renderer.root).length
    const initialRenderables = countRenderables(viewer.app.renderer.root)
    expect(initialScrollBoxes).toBe(1)
    expect(initialRenderables).toBeLessThan(100)
    expect(viewer.kvValue("diff_viewer_show_file_tree")).toBe(true)
    expect(viewer.kvWrites()).toEqual([])

    viewer.commands.get("diff.toggle_file_tree")!.run?.({} as never)
    await viewer.app.waitFor(() => findScrollBoxes(viewer.app.renderer.root).length > initialScrollBoxes)
    expect(countRenderables(viewer.app.renderer.root)).toBeGreaterThan(initialRenderables + 1_000)
    expect(viewer.kvValue("diff_viewer_show_file_tree")).toBe(true)
    expect(viewer.kvWrites()).toEqual([])
  } finally {
    viewer.app.renderer.destroy()
  }
})

async function renderDiffViewer(
  vcsDiff: unknown[],
  height = 20,
  initialRoute?: TuiRouteCurrent,
  initialKv: Record<string, unknown> = {},
) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current = initialRoute ?? startRoute
  let renderDiff: TuiRouteDefinition["render"] | undefined
  let vcsDiffInput: unknown
  let sessionDiffInput: unknown
  let kv: TuiPluginApi["kv"] | undefined
  const kvWrites: { name: string; value: unknown }[] = []
  const config = createTuiResolvedConfig()
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        vcs: {
          diff: async (input: unknown) => {
            vcsDiffInput = input
            return { data: vcsDiff }
          },
        },
        session: {
          diff: async (input: unknown) => {
            sessionDiffInput = input
            return { data: [] }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          get: () => session,
        },
      },
    })
    Object.entries(initialKv).forEach(([name, value]) => base.kv.set(name, value))
    const setKv = base.kv.set.bind(base.kv)
    base.kv.set = (name, value) => {
      kvWrites.push({ name, value })
      setKv(name, value)
    }
    kv = base.kv
    const api = {
      ...base,
      route: {
        register(routes) {
          renderDiff = routes.find((route) => route.name === "diff")?.render
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    void diffViewerPlugin.tui(api, undefined, pluginMeta)
    if (!initialRoute) commands.get("diff.open")?.run?.({} as never)

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state: path.join(root, "state"), worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                {renderDiff?.({ params: "params" in current ? current.params : undefined })}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height })
  await waitForCommand(app, commands, "diff.close")
  return {
    app,
    commands,
    current: () => current,
    vcsDiffInput: () => vcsDiffInput,
    sessionDiffInput: () => sessionDiffInput,
    kvValue: (name: string) => kv?.get(name),
    kvWrites: () => kvWrites,
  }
}

const startRoute: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && containsDiff(root)) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

function containsDiff(root: Renderable): boolean {
  if (root instanceof DiffRenderable) return true
  return root.getChildren().some(containsDiff)
}

function findDiffs(root: Renderable): DiffRenderable[] {
  return [...(root instanceof DiffRenderable ? [root] : []), ...root.getChildren().flatMap(findDiffs)]
}

function findScrollBoxes(root: Renderable): ScrollBoxRenderable[] {
  return [...(root instanceof ScrollBoxRenderable ? [root] : []), ...root.getChildren().flatMap(findScrollBoxes)]
}

function countRenderables(root: Renderable): number {
  return 1 + root.getChildren().reduce((total, child) => total + countRenderables(child), 0)
}

function diffFile(file: string, patch = smallPatch(file)) {
  return {
    file,
    additions: 1,
    deletions: 1,
    status: "modified",
    patch,
  }
}

function smallPatch(file: string) {
  return `--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-old
+new`
}

function paddedPatch(file: string, characters: number) {
  return `--- a/${file}
+++ b/${file}
@@ -1,2 +1,2 @@
 ${"x".repeat(characters)}
-old
+new`
}

const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "/repo/session",
  title: "Session",
  version: "1",
  time: {
    created: 0,
    updated: 0,
  },
} satisfies Session

test("branch diff source requests branch VCS diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: 12 })
    expect(viewer.sessionDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("last-turn diff source requests session diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
    })
    expect(viewer.sessionDiffInput()).toEqual({ sessionID: "session-1", messageID: "message-1" })
    expect(viewer.vcsDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  command: string,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    if (commands.has(command)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const pluginMeta = {
  id: "diff-viewer",
  source: "internal",
  spec: "diff-viewer",
  target: "diff-viewer",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta
