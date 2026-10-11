/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DialogImagePreview } from "../../src/component/dialog-image-preview"
import { renderLocal } from "../fixture/local"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test("the image dialog saves the previewed bytes through the save prompt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dialog-image-preview-"))
  try {
    await using setup = await renderLocal({ cwd: directory })
    setup.dialog.replace(() => (
      <DialogImagePreview
        images={[{ uri: `data:image/png;base64,${PNG.toString("base64")}`, mention: { text: "shot" } }]}
        initial={0}
      />
    ))
    await setup.waitForFrame((frame) => frame.includes("Image 1 of 1"))

    setup.mockInput.pressKey("s")
    await setup.waitForFrame((frame) => frame.includes("Save image"))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => setup.dialog.stack.length === 0)

    expect(new Uint8Array(await readFile(path.join(directory, "img", "shot.png")))).toEqual(new Uint8Array(PNG))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
