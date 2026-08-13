import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  markdownSessionImages,
  projectSessionImages,
  selectViewportSessionImageKeys,
  sessionImageAuto,
  sessionImagePreviewActive,
  sessionImagePreviewHeight,
  textPartSessionImages,
  toolSessionImages,
} from "../../src/util/session-image"

type Completed = Extract<ToolPart["state"], { status: "completed" }>

function completed(
  input: Partial<Pick<Completed, "output" | "attachments">> & { id?: string; tool?: string },
): ToolPart {
  return {
    id: input.id ?? "part_tool",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: "call_test",
    tool: input.tool ?? "image",
    state: {
      status: "completed",
      input: {},
      title: "Generated image",
      metadata: {},
      time: { start: 1, end: 2 },
      output: input.output ?? "",
      attachments: input.attachments,
    },
  }
}

describe("session images", () => {
  test("keeps structured image attachments generic", () => {
    const uri = "https://example.com/download?token=1"
    expect(
      toolSessionImages(
        completed({
          attachments: [
            {
              id: "part_image",
              sessionID: "ses_test",
              messageID: "msg_test",
              type: "file",
              mime: "image/webp",
              filename: "  result\n.webp\u0007  ",
              url: uri,
            },
          ],
        }),
      ),
    ).toEqual([{ key: "attachment:part_image", uri, label: "result .webp", source: "attachment" }])
  })

  test("does not recognize Yesmem output or mine arbitrary tool output", () => {
    const uri = "https://example.com/image.png"
    expect(
      toolSessionImages(
        completed({
          tool: "yesmem_execute_cap",
          output: JSON.stringify({ cap_name: "generate_image", output: JSON.stringify({ url: uri }) }),
        }),
      ),
    ).toEqual([])
    expect(toolSessionImages(completed({ tool: "bash", output: `result: ${uri}` }))).toEqual([])
  })

  test("extracts standard Markdown images and preserves signed URL bytes", () => {
    const signed = "https://example.com/render.png?signature=abc!();:%2Bb&x=1#preview"
    const reference = "https://cdn.example.com/result.webp?token=a+b&expires=123"
    const content = [
      `![Generated result](<${signed}> \"preview\")`,
      "![Reference result][asset]",
      "",
      `[asset]: <${reference}>`,
    ].join("\n")

    expect(markdownSessionImages(content)).toEqual([
      { key: "markdown:0", uri: signed, label: "Generated result", source: "markdown" },
      { key: "markdown:1", uri: reference, label: "Reference result", source: "markdown" },
    ])
    expect(content).toContain(`<${signed}>`)
  })

  test("honors Markdown semantics instead of matching image-looking text", () => {
    const uri = "https://example.com/ignored.png"
    const content = [
      `\\![escaped](${uri})`,
      `\`![inline code](${uri})\``,
      "```md",
      `![fenced code](${uri})`,
      "```",
      "~~~md",
      `![tilde code](${uri})`,
      "~~~",
      `    ![indented code](${uri})`,
      `<img src=\"${uri}\">`,
      `[plain link](${uri})`,
    ].join("\n")

    expect(markdownSessionImages(content)).toEqual([])
  })

  test("projects only a durably completed text part", () => {
    const text = "![Result](https://example.com/result.png)"
    const completedPart = { text, time: { start: 1, end: 2 } }
    expect(textPartSessionImages({ text, time: { start: 1 } }, true)).toEqual([])
    expect(textPartSessionImages(completedPart, false)).toEqual([])
    const images = textPartSessionImages(completedPart, true)
    expect(images).toHaveLength(1)
    expect(textPartSessionImages(completedPart, true)).toBe(images)
    expect(textPartSessionImages({ text }, false)).toEqual([])
    expect(textPartSessionImages({ text }, true)).toHaveLength(1)
  })

  test("finds reference images in nested Markdown structures", () => {
    const content = [
      "> ![quote][quote-image]",
      "",
      "- ![list](https://example.com/list.png)",
      "",
      "| preview |",
      "| --- |",
      "| ![table](https://example.com/table.png) |",
      "",
      "[quote-image]: https://example.com/quote.png",
    ].join("\n")

    expect(markdownSessionImages(content).map((image) => image.uri)).toEqual([
      "https://example.com/quote.png",
      "https://example.com/list.png",
      "https://example.com/table.png",
    ])
  })

  test("filters unsafe sources, removes duplicates, and bounds the result", () => {
    const accepted = Array.from({ length: 30 }, (_, index) => `![Image ${index}](https://example.com/${index}.png)`)
    const content = [
      "![HTTP](http://example.com/image.png)",
      "![Local](https://127.0.0.1/image.png)",
      "![File](file:///etc/passwd)",
      "![Duplicate](https://example.com/0.png)",
      ...accepted,
    ].join("\n")
    const images = markdownSessionImages(content)

    expect(images).toHaveLength(24)
    expect(new Set(images.map((image) => image.uri)).size).toBe(24)
    expect(images[0].uri).toBe("https://example.com/0.png")
    expect(markdownSessionImages("![Inline](data:image/png;base64,aGVsbG8=)")).toHaveLength(1)
  })

  test("automatically previews Markdown and inline attachments but not remote attachments", () => {
    expect(
      sessionImageAuto({
        key: "markdown:0",
        uri: "https://example.com/image.png",
        label: "Markdown",
        source: "markdown",
      }),
    ).toBeTrue()
    expect(
      sessionImageAuto({
        key: "inline",
        uri: "data:image/png;base64,aGVsbG8=",
        label: "Inline attachment",
        source: "attachment",
      }),
    ).toBeTrue()
    expect(
      sessionImageAuto({
        key: "remote",
        uri: "https://example.com/attachment.png",
        label: "Remote attachment",
        source: "attachment",
      }),
    ).toBeFalse()
  })

  test("selects one native image near the viewport across a 12-image history", () => {
    const images = Array.from({ length: 12 }, (_, index) => ({
      key: `image-${index}`,
      y: index * 10,
      height: 6,
    }))

    expect([...selectViewportSessionImageKeys(images, 40, 20)]).toEqual(["image-5"])
    expect([...selectViewportSessionImageKeys(images, 90, 20)]).toEqual(["image-10"])
    expect(selectViewportSessionImageKeys(images, 40, 20).size).toBe(1)
    expect(selectViewportSessionImageKeys(images, 40, 20, 4).size).toBe(4)
    expect([...selectViewportSessionImageKeys([{ key: "overscan", y: 25, height: 5 }], 40, 20)]).toEqual(["overscan"])
    expect(selectViewportSessionImageKeys([{ key: "overscan", y: 25, height: 5 }], 40, 20, 1, 0).size).toBe(0)
    expect(selectViewportSessionImageKeys(images, 40, 0).size).toBe(0)
  })

  test("keeps a resident native preview independent of session activity", () => {
    const base = { supported: true, dialogOpen: false, resident: true, failed: false }

    expect(sessionImagePreviewActive(base)).toBeTrue()
    expect(sessionImagePreviewActive({ ...base, resident: false })).toBeFalse()
    expect(sessionImagePreviewActive({ ...base, dialogOpen: true })).toBeFalse()
    expect(sessionImagePreviewActive({ ...base, failed: true })).toBeFalse()
  })

  test("projects one full-width image and sizes it without cropping", () => {
    const images = ["a", "b", "c"].map((uri) => ({
      key: uri,
      uri,
      label: uri,
      source: "markdown" as const,
    }))

    expect(projectSessionImages(images)).toEqual({ visible: images.slice(0, 1), hidden: 2 })
    expect(sessionImagePreviewHeight(24, 80)).toBe(23)
    expect(sessionImagePreviewHeight(40, 120, 1, 1, 2)).toBe(60)
    expect(sessionImagePreviewHeight(24, 80, 1, 10, 2)).toBe(48)
    expect(sessionImagePreviewHeight(3, 10)).toBe(3)
  })
})
