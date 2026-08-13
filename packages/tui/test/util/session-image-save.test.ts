import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { saveSessionImage, sessionImageFilename } from "../../src/util/session-image-save"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("session image saving", () => {
  test("derives a safe filename from the image label and actual image bytes", () => {
    const data = Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64")
    expect(
      sessionImageFilename(
        {
          key: "markdown:0",
          uri: "https://example.com/generated/chart.jpeg?signature=secret",
          label: "Quarterly chart",
          source: "markdown",
        },
        data,
      ),
    ).toBe("Quarterly chart.png")
  })

  test("falls back to the remote basename for generic markdown labels", () => {
    const data = Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64")
    expect(
      sessionImageFilename(
        {
          key: "markdown:0",
          uri: "https://example.com/generated/chart.jpeg?signature=secret",
          label: "Image",
          source: "markdown",
        },
        data,
      ),
    ).toBe("chart.png")
  })

  test("sanitizes inline image labels without allowing path traversal", () => {
    expect(
      sessionImageFilename(
        { key: "markdown:0", uri: pixel, label: "../../quarter:one", source: "markdown" },
        Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64"),
      ),
    ).toBe("quarter-one.png")
    expect(
      sessionImageFilename(
        { key: "markdown:0", uri: pixel, label: "CON.txt", source: "markdown" },
        Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64"),
      ),
    ).toBe("_CON.txt.png")
  })

  test("writes original bytes and never overwrites an existing download", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-image-save-"))
    directories.push(directory)
    const image = { key: "markdown:0", uri: pixel, label: "result", source: "markdown" } as const

    const first = await saveSessionImage(image, directory)
    const second = await saveSessionImage(image, directory)

    expect(path.basename(first)).toBe("result.png")
    expect(path.basename(second)).toBe("result-2.png")
    expect(await readFile(first)).toEqual(Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64"))
    expect(await readFile(second)).toEqual(await readFile(first))
    expect((await stat(first)).mode & 0o111).toBe(0)
  })

  test("reuses already-loaded source bytes instead of fetching the URI again", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-image-save-"))
    directories.push(directory)
    const data = Buffer.from(pixel.slice(pixel.indexOf(",") + 1), "base64")
    const target = await saveSessionImage(
      { key: "markdown:0", uri: "invalid", label: "cached", source: "markdown" },
      directory,
      undefined,
      data,
    )

    expect(path.basename(target)).toBe("cached.png")
    expect(await readFile(target)).toEqual(data)
  })

  test("does not follow an existing destination symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-image-save-"))
    directories.push(root)
    const directory = path.join(root, "Downloads")
    const protectedFile = path.join(root, "protected.txt")
    await mkdir(directory)
    await Bun.write(protectedFile, "unchanged")
    await symlink(protectedFile, path.join(directory, "result.png"))

    const target = await saveSessionImage(
      { key: "markdown:0", uri: pixel, label: "result", source: "markdown" },
      directory,
    )

    expect(path.basename(target)).toBe("result-2.png")
    expect(await readFile(protectedFile, "utf8")).toBe("unchanged")
  })

  test("publishes concurrent saves atomically under distinct names", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-image-save-"))
    directories.push(directory)
    const image = { key: "markdown:0", uri: pixel, label: "parallel", source: "markdown" } as const

    const targets = await Promise.all([saveSessionImage(image, directory), saveSessionImage(image, directory)])

    expect(targets.map((target) => path.basename(target)).toSorted()).toEqual(["parallel-2.png", "parallel.png"])
    expect(await readFile(targets[0])).toEqual(await readFile(targets[1]))
    expect((await readdir(directory)).toSorted()).toEqual(["parallel-2.png", "parallel.png"])
  })

  test("an invalid or aborted source creates no download directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-image-save-"))
    directories.push(root)
    const invalidDirectory = path.join(root, "invalid")
    const abortedDirectory = path.join(root, "aborted")
    const invalid = await saveSessionImage(
      { key: "markdown:0", uri: "data:image/png;base64,aGVsbG8=", label: "invalid", source: "markdown" },
      invalidDirectory,
    ).then(
      () => undefined,
      (error) => error,
    )
    const controller = new AbortController()
    controller.abort()
    const aborted = await saveSessionImage(
      { key: "markdown:0", uri: pixel, label: "aborted", source: "markdown" },
      abortedDirectory,
      controller.signal,
    ).then(
      () => undefined,
      (error) => error,
    )

    expect(invalid).toBeInstanceOf(Error)
    expect(aborted).toBeInstanceOf(Error)
    expect(
      await access(invalidDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(
      await access(abortedDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })
})
