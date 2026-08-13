/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { access, mkdir, readFile } from "node:fs/promises"
import { onCleanup } from "solid-js"
import type { TuiKeybind } from "../../src/config/keybind"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const transparentPixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

async function mount(root: string, keybinds: Partial<TuiKeybind.Keybinds> = {}) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogImagePreview },
    { DialogProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../src/component/dialog-image-preview"),
    import("../../src/ui/dialog"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogImagePreview
                      initial={0}
                      projectDirectory={root}
                      images={[
                        { key: "markdown:0", uri: pixel, label: "first", source: "markdown" },
                        { key: "markdown:1", uri: transparentPixel, label: "second", source: "markdown" },
                      ]}
                    />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  return testRender(() => <Harness />, { height: 20, kittyKeyboard: true, useThread: false, width: 80 })
}

test("saves the currently selected image to the project img directory without re-encoding", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await Bun.sleep(300)
    app.mockInput.pressArrow("right")
    await Bun.sleep(20)
    app.mockInput.pressKey("s")
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused save directory prompt")
    expect(textarea.plainText).toBe(path.join(tmp.path, "img"))
    app.mockInput.pressEnter()

    const target = path.join(tmp.path, "img", "second.png")
    await wait(() => Bun.file(target).exists())

    expect(await readFile(target)).toEqual(
      Buffer.from(transparentPixel.slice(transparentPixel.indexOf(",") + 1), "base64"),
    )
    expect(await Bun.file(path.join(tmp.path, "img", "first.png")).exists()).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("uses the configured image save keybinding", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path, { "dialog.image.save": "ctrl+y" })
  try {
    const target = path.join(tmp.path, "img", "first.png")
    await Bun.sleep(300)
    app.mockInput.pressKey("s")
    await Bun.sleep(30)
    expect(await Bun.file(target).exists()).toBe(false)
    expect(app.renderer.currentFocusedEditor).not.toBeInstanceOf(TextareaRenderable)

    app.mockInput.pressKey("y", { ctrl: true })
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    app.mockInput.pressEnter()
    await wait(() => Bun.file(target).exists())
    expect(await Bun.file(target).exists()).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("resolves a custom relative directory from the project", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await Bun.sleep(300)
    app.mockInput.pressKey("s")
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused save directory prompt")
    textarea.setText(path.join("art", "generated"))
    app.mockInput.pressEnter()

    const target = path.join(tmp.path, "art", "generated", "first.png")
    await wait(() => Bun.file(target).exists())
    expect(await readFile(target)).toEqual(Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64"))
  } finally {
    app.renderer.destroy()
  }
})

test("canceling the save directory dialog performs no filesystem work", async () => {
  await using tmp = await tmpdir()
  const app = await mount(tmp.path)
  try {
    await Bun.sleep(300)
    app.mockInput.pressKey("s")
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    app.mockInput.pressEscape()
    await Bun.sleep(30)

    expect(
      await access(path.join(tmp.path, "img")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

async function wait(check: () => boolean | Promise<boolean>) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for image download")
    await Bun.sleep(10)
  }
}
