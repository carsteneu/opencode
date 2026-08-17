/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DiffRenderable, type Renderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { EditBody } from "../../../src/routes/session/permission"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"

test("defers a large permission diff until fullscreen is requested", async () => {
  await using tmp = await tmpdir()
  const diff = patch("large.ts", 501)
  const request = permission({ filepath: "/repo/large.ts", diff })
  let expand: ((value: boolean) => void) | undefined

  function Harness() {
    const [expanded, setExpanded] = createSignal(false)
    expand = setExpanded
    return <PermissionDiff request={request} expanded={expanded} />
  }

  const app = await render(() => <Harness />, tmp.path)
  try {
    expect(text(app.renderer.root)).toContain("Large diff preview")
    expect(text(app.renderer.root)).toContain("Preview limited")
    expect(findDiffs(app.renderer.root)).toEqual([])

    expand?.(true)
    await app.renderOnce()
    await app.waitFor(() => findDiffs(app.renderer.root).length === 1)
    expect(findDiffs(app.renderer.root)[0]?.diff).toBe(diff)
  } finally {
    app.renderer.destroy()
  }
})

test("renders every small apply-patch file instead of only the first", async () => {
  await using tmp = await tmpdir()
  const first = patch("first.ts", 2)
  const second = patch("second.ts", 2)
  const request = permission({
    filepath: "first.ts, second.ts",
    diff: `${first}\n${second}`,
    files: [
      { filePath: "/repo/first.ts", relativePath: "first.ts", patch: first, additions: 2, deletions: 0 },
      { filePath: "/repo/second.ts", relativePath: "second.ts", patch: second, additions: 2, deletions: 0 },
    ],
  })

  const app = await render(() => <PermissionDiff request={request} expanded={() => false} />, tmp.path)
  try {
    await app.waitFor(() => findDiffs(app.renderer.root).length === 2)
    expect(findDiffs(app.renderer.root).map((item) => item.diff)).toEqual([first, second])
  } finally {
    app.renderer.destroy()
  }
})

test("shows the existing no-diff fallback for patchless apply-patch permission metadata", async () => {
  await using tmp = await tmpdir()
  const request = permission({
    filepath: "first.ts, second.ts",
    files: [
      { filePath: "/repo/first.ts", relativePath: "first.ts", additions: 2, deletions: 1 },
      { filePath: "/repo/second.ts", relativePath: "second.ts", additions: 3, deletions: 4 },
    ],
  })

  const app = await render(() => <PermissionDiff request={request} expanded={() => false} />, tmp.path)
  try {
    expect(findDiffs(app.renderer.root)).toEqual([])
    expect(text(app.renderer.root)).toContain("No diff provided")
  } finally {
    app.renderer.destroy()
  }
})

test("bounds a many-file permission diff without mutating its exact patches", async () => {
  await using tmp = await tmpdir()
  const files = Array.from({ length: 21 }, (_, index) => {
    const value = patch(`file-${index}.ts`, 2)
    return {
      filePath: `/repo/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      patch: value,
      additions: 2,
      deletions: 0,
    }
  })
  const diff = files.map((file) => file.patch).join("\n")
  const request = permission({ filepath: files.map((file) => file.relativePath).join(", "), diff, files })
  let expand: ((value: boolean) => void) | undefined

  function Harness() {
    const [expanded, setExpanded] = createSignal(false)
    expand = setExpanded
    return <PermissionDiff request={request} expanded={expanded} />
  }

  const app = await render(() => <Harness />, tmp.path)
  try {
    expect(findDiffs(app.renderer.root)).toEqual([])
    expect(text(app.renderer.root)).toContain("Large diff preview")
    expect(text(app.renderer.root)).not.toContain("--- a/file-10.ts")

    expand?.(true)
    await app.renderOnce()
    await app.waitFor(() => text(app.renderer.root).includes("Complete raw diff · 21 files"))
    expect(findDiffs(app.renderer.root)).toEqual([])
    expect(text(app.renderer.root)).toContain("--- a/file-10.ts")
    expect(request.metadata?.diff).toBe(diff)
    expect(request.metadata?.files).toBe(files)
  } finally {
    app.renderer.destroy()
  }
})

function PermissionDiffEnvironment(props: { root: string; children: JSX.Element }) {
  return (
    <TestTuiContexts
      directory={props.root}
      paths={{ home: props.root, state: path.join(props.root, "state"), worktree: props.root }}
    >
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            {props.children}
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function PermissionDiff(props: { request: PermissionRequest; expanded: () => boolean }) {
  return <EditBody request={props.request} expanded={props.expanded} />
}

async function render(component: () => JSX.Element, root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const app = await testRender(() => <PermissionDiffEnvironment root={root}>{component()}</PermissionDiffEnvironment>, {
    width: 120,
    height: 30,
  })
  const started = performance.now()
  while (text(app.renderer.root).length === 0 && findDiffs(app.renderer.root).length === 0) {
    if (performance.now() - started > 2_000) throw new Error("Timed out mounting the permission diff")
    await Bun.sleep(10)
    await app.renderOnce()
  }
  return app
}

function permission(metadata: Record<string, unknown>) {
  return {
    id: "per_diff",
    sessionID: "ses_diff",
    permission: "edit",
    patterns: ["*"],
    always: ["*"],
    metadata,
  } satisfies PermissionRequest
}

function patch(file: string, additions: number) {
  return `--- a/${file}
+++ b/${file}
@@ -0,0 +1,${additions} @@
${Array.from({ length: additions }, (_, index) => `+const line_${index} = ${index}`).join("\n")}`
}

function findDiffs(root: Renderable): DiffRenderable[] {
  return [...(root instanceof DiffRenderable ? [root] : []), ...root.getChildren().flatMap((child) => findDiffs(child))]
}

function text(root: Renderable): string {
  return [root instanceof TextRenderable ? root.plainText : "", ...root.getChildren().map(text)].join("\n")
}
