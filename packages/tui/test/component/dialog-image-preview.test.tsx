/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { onMount } from "solid-js"
import { DialogImagePreview } from "../../src/component/dialog-image-preview"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const image = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`

test("the preview advertises the save binding from the keymap, not a hardcoded hint", async () => {
  await using temporary = await tmpdir()
  function Harness() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogImagePreview images={[{ uri: image, mention: { text: "diagram.png" } }]} initial={0} />))
    return <box />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <Harness />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Image 1 of 1") && frame.includes("save"))
    expect(app.captureCharFrame()).toContain("s save")
    expect(app.captureCharFrame()).toContain("esc")

    app.mockInput.pressKey("s")
    const target = path.join(temporary.path, "Downloads", "diagram.png")
    await app.waitFor(() => existsSync(target))
    expect(Array.from(await Bun.file(target).bytes())).toEqual([0x89, 0x50, 0x4e, 0x47])
  } finally {
    app.renderer.destroy()
  }
})
