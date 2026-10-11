import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { saveSessionImage, sessionImageFilename } from "../../src/util/session-image-save"
import { tmpdir } from "../fixture/fixture"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (data = PNG) => `data:image/png;base64,${Buffer.from(data).toString("base64")}`

describe("sessionImageFilename", () => {
  test("uses the label as the stem and the data URI media type as the extension", () => {
    expect(sessionImageFilename(png(), "diagram.png")).toBe("diagram.png")
    expect(sessionImageFilename("data:image/jpeg;base64,/9j/", "shot.jpeg")).toBe("shot.jpg")
    expect(sessionImageFilename("data:image/webp;base64,AAAA", "capture.webp")).toBe("capture.webp")
    expect(sessionImageFilename("data:image/gif;base64,AAAA", "loop.gif")).toBe("loop.gif")
  })

  test("falls back to the label extension for an unrecognised media type", () => {
    expect(sessionImageFilename("data:application/octet-stream;base64,AAAA", "screenshot.png")).toBe(
      "screenshot.png",
    )
    expect(sessionImageFilename("data:application/octet-stream;base64,AAAA", "no-extension")).toBe("no-extension.bin")
  })

  test("defaults to a portable name when there is no label", () => {
    expect(sessionImageFilename(png())).toBe("opencode-image.png")
    expect(sessionImageFilename(png(), "   ")).toBe("opencode-image.png")
  })

  test("strips separators and reserved device names", () => {
    expect(sessionImageFilename(png(), "a/b:c*d?e.png")).toBe("a-b-c-d-e.png")
    expect(sessionImageFilename(png(), "con.png")).toBe("_con.png")
    expect(sessionImageFilename(png(), `${"x".repeat(80)}.png`)).toBe(`${"x".repeat(60)}.png`)
  })

  test("rejects anything that is not an inline image data URI", () => {
    expect(() => sessionImageFilename("https://example.test/a.png")).toThrow("Only inline image data URIs")
    expect(() => sessionImageFilename("data:image/png;base64,@@@")).toThrow("Only inline image data URIs")
    expect(() => sessionImageFilename("data:image/png;base64,AAAAA")).toThrow("Only inline image data URIs")
    expect(() => sessionImageFilename("data:image/png,rawtext")).toThrow("Only inline image data URIs")
  })
})

describe("saveSessionImage", () => {
  test("writes the decoded bytes into the directory, creating it", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "nested", "downloads")

    const target = await saveSessionImage(png(Uint8Array.of(1, 2, 3, 4)), directory, "diagram.png")

    expect(target).toBe(path.join(directory, "diagram.png"))
    expect(Array.from(await fs.readFile(target))).toEqual([1, 2, 3, 4])
    expect(await fs.readdir(directory)).toEqual(["diagram.png"])
  })

  test("never overwrites an existing file", async () => {
    await using tmp = await tmpdir()
    await saveSessionImage(png(Uint8Array.of(1)), tmp.path, "diagram.png")
    const second = await saveSessionImage(png(Uint8Array.of(2)), tmp.path, "diagram.png")
    const third = await saveSessionImage(png(Uint8Array.of(3)), tmp.path, "diagram.png")

    expect(path.basename(second)).toBe("diagram-2.png")
    expect(path.basename(third)).toBe("diagram-3.png")
    expect(Array.from(await fs.readFile(path.join(tmp.path, "diagram.png")))).toEqual([1])
    expect((await fs.readdir(tmp.path)).sort()).toEqual(["diagram-2.png", "diagram-3.png", "diagram.png"])
  })

  test("leaves no temporary file behind on failure", async () => {
    await using tmp = await tmpdir()
    await expect(saveSessionImage("https://example.test/a.png", tmp.path)).rejects.toThrow(
      "Only inline image data URIs",
    )
    expect(await fs.readdir(tmp.path)).toEqual([])
  })
})
