/** @jsxImportSource @opentui/solid */
import { Renderable, RGBA, StyledText, TextRenderable, fg, t } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, type Setter } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { PartialText } from "../../src/ui/partial-text"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const cellWidth = 48
const long = t`${fg(RGBA.fromHex("#ff00ff"))("LONG value")} with moving spaces and glyphs`
const short = t`${fg(RGBA.fromHex("#00ffff"))("new")} gap`

test("partial text redraws one exact region in a large tree and becomes completely idle", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let update!: Setter<string | StyledText>

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const [content, setContent] = createSignal<string | StyledText>(long)
    update = setContent
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <ToastProvider>
                  <DialogProvider>
                    <box width={80} height={43}>
                      <box height={40} overflow="hidden" flexShrink={0}>
                        <box height={520} flexShrink={0}>
                          {Array.from({ length: 520 }, (_, index) => (
                            <text content={`history-${index}`} />
                          ))}
                        </box>
                      </box>
                      <box height={1} paddingLeft={4} flexShrink={0}>
                        <PartialText content={content()} fg={RGBA.fromHex("#ffffff")} width={cellWidth} truncate />
                      </box>
                    </box>
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { height: 43, useThread: false, width: 80 })
  const target = await waitForText(app, cellWidth)
  await app.renderer.idle()
  expect(normalized(target.plainText).trimEnd()).toBe(visual(long))
  const internals = app.renderer as unknown as RendererInternals
  const requests = captureRequests(app.renderer)
  const native = captureNativeRenders(app.renderer)

  try {
    expect((app.renderer.root as unknown as { renderList: unknown[] }).renderList.length).toBeGreaterThan(500)

    update(short)
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toEqual([target])
    expect(internals.partialRequests.has(target)).toBe(true)
    expect(target.isInRenderPath()).toBe(true)
    expect(app.renderer.root.isPartialRenderStateCurrent()).toBe(true)
    expect(app.renderer.root.hasSafePartialComposition(new Set([target]))).toBe(true)
    expect(internals.canPartialRender()).toBe(true)
    expect(app.renderer.root.getLayoutNode().isDirty()).toBe(false)
    await app.renderer.idle()

    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(1)
    expect(native.partial[0].slice(-4)).toEqual(partialRegion(app.renderer, target))
    expect(frameCell(app, target)).toBe(visual(short).padEnd(cellWidth))

    requests.clear()
    native.clear()
    update("")
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toEqual([target])
    expect(internals.partialRequests.has(target)).toBe(true)
    expect(internals.canPartialRender()).toBe(true)
    expect(app.renderer.root.getLayoutNode().isDirty()).toBe(false)
    await app.renderer.idle()

    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(1)
    expect(native.partial[0].slice(-4)).toEqual(partialRegion(app.renderer, target))
    expect(frameCell(app, target)).toBe(" ".repeat(cellWidth))

    requests.clear()
    native.clear()
    await Bun.sleep(5000)
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toHaveLength(0)
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(0)
  } finally {
    native.restore()
    requests.restore()
    app.renderer.destroy()
  }
}, 10_000)

function captureRequests(renderer: Awaited<ReturnType<typeof testRender>>["renderer"]) {
  const ordinary: Array<Renderable | undefined> = []
  const partial: Renderable[] = []
  const requestRender = renderer.requestRender
  const requestPartialRender = renderer.requestPartialRender
  renderer.requestRender = (source) => {
    ordinary.push(source)
    requestRender.call(renderer, source)
  }
  renderer.requestPartialRender = (renderable) => {
    partial.push(renderable)
    requestPartialRender.call(renderer, renderable)
  }
  return {
    ordinary,
    partial,
    clear() {
      ordinary.length = 0
      partial.length = 0
    },
    restore() {
      renderer.requestRender = requestRender
      renderer.requestPartialRender = requestPartialRender
    },
  }
}

function captureNativeRenders(renderer: Awaited<ReturnType<typeof testRender>>["renderer"]) {
  const internals = renderer as unknown as {
    lib: {
      render(...args: unknown[]): number
      renderPartial(...args: unknown[]): number
    }
  }
  const full: unknown[][] = []
  const partial: unknown[][] = []
  const render = internals.lib.render
  const renderPartial = internals.lib.renderPartial
  internals.lib.render = (...args) => {
    full.push(args)
    return render.apply(internals.lib, args)
  }
  internals.lib.renderPartial = (...args) => {
    partial.push(args)
    return renderPartial.apply(internals.lib, args)
  }
  return {
    full,
    partial,
    clear() {
      full.length = 0
      partial.length = 0
    },
    restore() {
      internals.lib.render = render
      internals.lib.renderPartial = renderPartial
    },
  }
}

async function waitForText(app: Awaited<ReturnType<typeof testRender>>, width: number) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    await app.renderOnce()
    const target = findText(app.renderer.root, width)
    if (target) return target
    await Bun.sleep(10)
  }
  throw new Error(`missing text renderable with width ${width}`)
}

function findText(root: Renderable, width: number): TextRenderable | undefined {
  if (root instanceof TextRenderable && root.width === width) return root
  for (const child of root.getChildren()) {
    const found = findText(child, width)
    if (found) return found
  }
}

function frameCell(app: Awaited<ReturnType<typeof testRender>>, target: TextRenderable) {
  return normalized(app.captureCharFrame())
    .split("\n")
    [target.screenY].slice(target.screenX, target.screenX + target.width)
}

function partialRegion(renderer: Awaited<ReturnType<typeof testRender>>["renderer"], target: TextRenderable) {
  const left = Math.max(0, target.screenX - 1)
  const right = Math.min(renderer.width, target.screenX + target.width + 1)
  return [left, target.screenY, right - left, target.height]
}

function visual(content: StyledText) {
  return content.chunks.map((chunk) => chunk.text).join("")
}

function normalized(value: string) {
  return value.replaceAll("\u00a0", " ")
}

type RendererInternals = {
  partialRequests: Set<Renderable>
  canPartialRender(): boolean
}
