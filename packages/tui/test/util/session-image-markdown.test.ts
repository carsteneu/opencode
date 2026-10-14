import { describe, expect, test } from "bun:test"
import { MARKDOWN_IMAGE_LIMIT, markdownImageSources, textPartImageSources } from "../../src/util/session-image-markdown"

const directory = "/work/project"
const sources = (content: string) => markdownImageSources(content, directory)

describe("markdown image sources", () => {
  test("reads the standard markdown image forms", () => {
    const signed = "https://cdn.example.com/render.png?signature=abc!();:%2Bb&x=1#preview"
    const content = [
      `![Generated](<${signed}> "preview")`,
      "![Reference][asset]",
      "",
      "[asset]: /tmp/out/result.png",
    ].join("\n")

    expect(sources(content).map((image) => image.source)).toEqual([signed, "/tmp/out/result.png"])
    expect(sources(content).map((image) => image.label)).toEqual(["Generated", "Reference"])
  })

  test("honors markdown semantics instead of matching image-looking text", () => {
    const target = "/tmp/out/ignored.png"
    const content = [
      `\\![escaped](${target})`,
      `\`![inline code](${target})\``,
      "```md",
      `![fenced code](${target})`,
      "```",
      "~~~md",
      `![tilde code](${target})`,
      "~~~",
      `    ![indented code](${target})`,
      `<img src="${target}">`,
      `[plain link](${target})`,
    ].join("\n")

    expect(sources(content)).toEqual([])
  })

  test("finds images in nested markdown structures", () => {
    const content = [
      "> ![quote][quote-image]",
      "",
      "- ![list](/tmp/out/list.png)",
      "",
      "| preview |",
      "| --- |",
      "| ![table](/tmp/out/table.png) |",
      "",
      "[quote-image]: /tmp/out/quote.png",
    ].join("\n")

    expect(sources(content).map((image) => image.source)).toEqual([
      "/tmp/out/quote.png",
      "/tmp/out/list.png",
      "/tmp/out/table.png",
    ])
  })

  test("removes duplicates and bounds the result", () => {
    const accepted = Array.from({ length: 30 }, (_, index) => `![Image ${index}](/tmp/out/${index}.png)`)
    const images = sources(["![Duplicate](/tmp/out/0.png)", ...accepted].join("\n"))

    expect(images).toHaveLength(MARKDOWN_IMAGE_LIMIT)
    expect(new Set(images.map((image) => image.source)).size).toBe(MARKDOWN_IMAGE_LIMIT)
    // Order of appearance, with the duplicate collapsed into the first mention.
    expect(images.map((image) => image.source).slice(0, 2)).toEqual(["/tmp/out/0.png", "/tmp/out/1.png"])
  })

  test("keeps two inline payloads that share a length and their head and tail", () => {
    const payload = "A".repeat(200)
    const one = `data:image/png;base64,${payload}`
    const two = `data:image/png;base64,${payload.slice(0, 100)}B${payload.slice(101)}`
    expect(one).not.toBe(two)
    expect(one.length).toBe(two.length)
    // A fingerprint over length plus head and tail would merge these into one image.
    expect(sources(`![one](${one})\n![two](${two})`).map((image) => image.source)).toEqual([one, two])
  })

  test("deduplicates the same remote source written twice", () => {
    const uri = "https://cdn.example.com/same.png"
    expect(sources(`![one](${uri})\n![two](${uri})`)).toHaveLength(1)
  })

  test("cleans the label and falls back when there is none", () => {
    const images = sources(["![  spaced\u0007name\u001f  ](/tmp/out/a.png)", "![](/tmp/out/b.png)"].join("\n"))
    expect(images.map((image) => image.label)).toEqual(["spaced name", "Image"])
  })

  test("caps a long label at 120 characters", () => {
    const long = "x".repeat(140)
    expect(sources(`![${long}](/tmp/out/a.png)`)[0]!.label).toHaveLength(120)
  })

  test("keeps an inline base64 image, as v1 did", () => {
    expect(sources("![inline](data:image/png;base64,aGVsbG8=)").map((image) => image.source)).toEqual([
      "data:image/png;base64,aGVsbG8=",
    ])
  })

  test("reads no images from a body without an image marker", () => {
    expect(sources("plain prose with no images")).toEqual([])
  })
})

describe("markdown image path resolution", () => {
  test("resolves a relative reference against the session directory", () => {
    expect(sources("![a](charts/one.png)").map((image) => image.source)).toEqual(["/work/project/charts/one.png"])
    expect(sources("![a](./charts/one.png)").map((image) => image.source)).toEqual(["/work/project/charts/one.png"])
    expect(sources("![a](chart%20one.png)").map((image) => image.source)).toEqual(["/work/project/chart one.png"])
  })

  test("skips a relative reference when the session has no directory", () => {
    expect(markdownImageSources("![a](charts/one.png)", undefined)).toEqual([])
  })

  test("keeps an absolute reference without a directory", () => {
    expect(markdownImageSources("![a](/tmp/one.png)", undefined).map((image) => image.source)).toEqual(["/tmp/one.png"])
  })

  test("reads the file url forms and the windows drive forms", () => {
    expect(sources("![a](file:///tmp/demo.png)").map((image) => image.source)).toEqual(["/tmp/demo.png"])
    expect(sources("![a](file://localhost/tmp/demo.png)").map((image) => image.source)).toEqual(["/tmp/demo.png"])
    expect(sources("![a](C:/tmp/chart.png)").map((image) => image.source)).toEqual(["C:/tmp/chart.png"])
  })

  test.each([
    ["a file url with a host", "![a](file://server/share/chart.png)"],
    ["an unc path", "![a](//server/share/chart.png)"],
    ["a custom scheme", "![a](custom:image.png)"],
    ["an svg data uri", "![a](data:image/svg+xml;base64,PHN2Zz4=)"],
    ["a drive relative path", "![a](C:chart.png)"],
    ["a control character", "![a](chart%00.png)"],
  ])("refuses %s", (_name, content) => {
    expect(sources(content)).toEqual([])
  })
})

describe("textPartImageSources", () => {
  const project = (
    part: { text: string },
    overrides: Partial<{ completed: boolean; enabled: boolean; directory: string | undefined }> = {},
  ) => textPartImageSources({ part, completed: true, enabled: true, directory, ...overrides })

  test("projects only a durably completed part", () => {
    const part = { text: "![chart](/tmp/chart.png)" }
    expect(project(part, { completed: false })).toEqual([])
    expect(project(part)).toHaveLength(1)
  })

  test("reads no sources at all while previews are disabled", () => {
    expect(project({ text: "![chart](https://cdn.example.com/chart.png)" }, { enabled: false })).toEqual([])
  })

  test("memoizes per part and directory", () => {
    const part = { text: "![chart](/tmp/chart.png)" }
    const first = project(part)
    expect(project(part)).toBe(first)
    const other = project(part, { directory: "/elsewhere" })
    expect(other).not.toBe(first)
    expect(project(part, { directory: "/elsewhere" })).toBe(other)
  })

  test("leaves the part text untouched", () => {
    const text = "![chart](/tmp/chart.png)"
    const part = { text }
    project(part)
    expect(part.text).toBe(text)
  })

  test("re-reads a part whose text changed", () => {
    const part = { text: "![one](/tmp/one.png)" }
    const first = project(part)
    part.text = "![two](/tmp/two.png)"
    const second = project(part)
    expect(second).not.toBe(first)
    expect(second.map((image) => image.source)).toEqual(["/tmp/two.png"])
  })
})
