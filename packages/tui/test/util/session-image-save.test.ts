import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decodeSessionImage, saveSessionImage, sessionImageFilename } from "../../src/util/session-image-save"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const png = `data:image/png;base64,${PNG.toString("base64")}`
const jpeg = `data:image/jpeg;base64,${JPEG.toString("base64")}`

test("decodes a base64 image data URL", () => {
  expect(decodeSessionImage(png)).toEqual(new Uint8Array(PNG))
  expect(decodeSessionImage(`data:image/png;base64,${PNG.toString("base64").slice(0, 8)}\n`)).toBeInstanceOf(Uint8Array)
})

test("rejects values that are not base64 image data URLs", () => {
  expect(() => decodeSessionImage("https://example.test/a.png")).toThrow()
  expect(() => decodeSessionImage("data:image/png,raw")).toThrow()
  expect(() => decodeSessionImage("data:image/png;base64,")).toThrow("Image preview contains no data")
})

test("names the file from the mime type and the label", () => {
  expect(sessionImageFilename(png)).toBe("opencode-image.png")
  expect(sessionImageFilename(png, "A screenshot")).toBe("A screenshot.png")
  expect(sessionImageFilename(jpeg, "shot.png")).toBe("shot.jpg")
  expect(sessionImageFilename(png, "../../etc/passwd")).toBe("etc-passwd.png")
  expect(sessionImageFilename(png, "...")).toBe("opencode-image.png")
})

test("writes the image, creating the directory, and returns the target path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-image-save-"))
  try {
    const directory = path.join(root, "nested", "img")
    const target = await saveSessionImage(png, directory, "shot")
    expect(target).toBe(path.join(directory, "shot.png"))
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array(PNG))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("never overwrites an existing file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-image-save-"))
  try {
    const first = await saveSessionImage(png, root, "shot")
    const second = await saveSessionImage(png, root, "shot")
    const third = await saveSessionImage(png, root, "shot")
    expect(first).toBe(path.join(root, "shot.png"))
    expect(second).toBe(path.join(root, "shot-2.png"))
    expect(third).toBe(path.join(root, "shot-3.png"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("requires a save directory", async () => {
  await expect(saveSessionImage(png, "   ")).rejects.toThrow("Image save directory is required")
  await expect(saveSessionImage(png, "bad\0dir")).rejects.toThrow("Image save directory is invalid")
})
