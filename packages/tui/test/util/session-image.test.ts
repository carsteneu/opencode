import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { projectSessionImages, sessionImagePreviewHeight, toolSessionImages } from "../../src/util/session-image"

type Completed = Extract<ToolPart["state"], { status: "completed" }>

function completed(input: Pick<Completed, "output" | "attachments">): Completed {
  return {
    status: "completed",
    input: {},
    title: "Generated image",
    metadata: {},
    time: { start: 1, end: 2 },
    ...input,
  }
}

describe("session images", () => {
  test("prefers structured image attachments and removes duplicate output URLs", () => {
    const uri = "https://v3b.fal.media/files/image.png"
    const signed = "https://example.com/download?token=1"
    const images = toolSessionImages(
      completed({
        output: `Generated ${uri}`,
        attachments: [
          {
            id: "part_image",
            sessionID: "ses_test",
            messageID: "msg_test",
            type: "file",
            mime: "image/png",
            filename: "result.png",
            url: uri,
          },
          {
            id: "part_signed_image",
            sessionID: "ses_test",
            messageID: "msg_test",
            type: "file",
            mime: "image/webp",
            filename: "signed.webp",
            url: signed,
          },
        ],
      }),
    )

    expect(images).toEqual([
      { uri, label: "result.png", source: "attachment" },
      { uri: signed, label: "signed.webp", source: "attachment" },
    ])
  })

  test("extracts only explicit supported image URLs from completed output", () => {
    const images = toolSessionImages(
      completed({
        output: [
          "![first](https://example.com/a.JPG?token=1)",
          "https://example.com/render?id=2",
          "https://example.com/vector.svg",
          "https://example.com/image.png.exe",
          "https://example.com/image.png/metadata",
          "ftp://example.com/ignored.png",
          "data:image/png;base64,aGVsbG8=",
          "https://example.com/final.webp#preview.",
        ].join("\n"),
      }),
    )

    expect(images.map((image) => image.uri)).toEqual([
      "https://example.com/a.JPG?token=1",
      "data:image/png;base64,aGVsbG8=",
      "https://example.com/final.webp#preview",
    ])
  })

  test("ignores unsupported attachments and incomplete tool state", () => {
    expect(
      toolSessionImages(
        completed({
          output: "",
          attachments: [
            {
              id: "part_svg",
              sessionID: "ses_test",
              messageID: "msg_test",
              type: "file",
              mime: "image/svg+xml",
              url: "https://example.com/image.svg",
            },
          ],
        }),
      ),
    ).toEqual([])
    expect(toolSessionImages({ status: "pending", input: {}, raw: "https://example.com/image.png" })).toEqual([])
  })

  test("bounds transcript thumbnails and reports hidden images", () => {
    const images = ["a", "b", "c", "d"].map((uri) => ({
      uri,
      label: uri,
      source: "output" as const,
    }))

    expect(projectSessionImages(images)).toEqual({ visible: images.slice(0, 3), hidden: 1 })
    expect(sessionImagePreviewHeight(12)).toBe(4)
    expect(sessionImagePreviewHeight(24)).toBe(6)
    expect(sessionImagePreviewHeight(80)).toBe(8)
  })
})
