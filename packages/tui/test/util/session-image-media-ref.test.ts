import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acquireImagePreview,
  releaseImagePreview,
  resolveImageToDataUri,
  setImageMediaReader,
} from "../../src/util/session-image-preview-cache"
import { saveSessionImage } from "../../src/util/session-image-save"
import { sizedImage } from "../fixture/sized-image"

const HASH = "a".repeat(64)
const REF = `media:${HASH}`

function bytesOf(dataUrl: string) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
}

afterEach(() => setImageMediaReader(undefined))

describe("media refs", () => {
  test("loads a stored image through the registered reader and sniffs its mime", async () => {
    const png = bytesOf(sizedImage(96, 48))
    setImageMediaReader(async (uri) => {
      expect(uri).toBe(REF)
      return png
    })

    const preview = await acquireImagePreview(REF)
    expect(preview).toStartWith("data:image/png;base64,")
    expect(Buffer.from(preview!.slice(preview!.indexOf(",") + 1), "base64")).toEqual(png)
    releaseImagePreview(REF)
  })

  test("previews nothing when no reader is registered", async () => {
    expect(await acquireImagePreview(REF)).toBeUndefined()
    expect(await resolveImageToDataUri(REF)).toBeUndefined()
    releaseImagePreview(REF)
  })

  test("previews nothing for bytes that are not an image", async () => {
    setImageMediaReader(async () => new Uint8Array([0x00, 0x01, 0x02, 0x03]))

    expect(await acquireImagePreview(REF)).toBeUndefined()
    releaseImagePreview(REF)
  })

  test("resolves to nothing when the blob is gone instead of failing the row", async () => {
    setImageMediaReader(async () => {
      throw new Error("missing")
    })

    expect(await resolveImageToDataUri(REF)).toBeUndefined()
  })

  test("drops the resolved bytes when the last consumer releases them", async () => {
    let reads = 0
    setImageMediaReader(async () => {
      reads += 1
      return bytesOf(sizedImage(96, 48))
    })

    const held = acquireImagePreview(REF)
    acquireImagePreview(REF)
    expect(await held).toStartWith("data:image/png;base64,")
    expect(reads).toBe(1)
    releaseImagePreview(REF)
    releaseImagePreview(REF)

    expect(await acquireImagePreview(REF)).toStartWith("data:image/png;base64,")
    expect(reads).toBe(2)
    releaseImagePreview(REF)
  })

  test("saves a stored image to disk", async () => {
    const png = bytesOf(sizedImage(96, 48))
    setImageMediaReader(async () => png)

    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-media-save-"))
    try {
      const target = await saveSessionImage(REF, directory, "stored chart")
      expect(await readFile(target)).toEqual(png)
      expect(path.basename(target)).toBe("stored chart.png")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("refuses to save a stored image that cannot be read", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-media-save-"))
    try {
      await expect(saveSessionImage(REF, directory)).rejects.toThrow("not a base64 data URL")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
