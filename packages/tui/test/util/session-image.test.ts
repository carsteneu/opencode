import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  projectSessionImages,
  selectAutoSessionImageKeys,
  sessionImageKey,
  sessionImagePreviewHeight,
  toolSessionImages,
} from "../../src/util/session-image"

type Completed = Extract<ToolPart["state"], { status: "completed" }>

function completed(input: Pick<Completed, "output" | "attachments"> & { id?: string; tool?: string }): ToolPart {
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
      output: input.output,
      attachments: input.attachments,
    },
  }
}

function capOutput(url: string, name = "generate_image") {
  return JSON.stringify({ cap_name: name, output: JSON.stringify({ url }) })
}

describe("session images", () => {
  test("prefers structured image attachments and removes a duplicate CAP result", () => {
    const uri = "https://v3b.fal.media/files/image.png"
    const signed = "https://example.com/download?token=1"
    const images = toolSessionImages(
      completed({
        tool: "yesmem_execute_cap",
        output: capOutput(uri),
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

  test("accepts only the trusted generate_image CAP result and preserves its URL bytes", () => {
    const uri = "https://example.com/render.png?signature=abc!();:#preview"
    expect(toolSessionImages(completed({ tool: "yesmem_execute_cap", output: capOutput(uri) }))).toEqual([
      { uri, label: "Generated image", source: "output" },
    ])

    expect(
      toolSessionImages(
        completed({ tool: "yesmem_execute_cap", output: capOutput("http://example.com/insecure.png") }),
      ),
    ).toEqual([])
    expect(toolSessionImages(completed({ tool: "yesmem_execute_cap", output: capOutput(uri, "other_cap") }))).toEqual(
      [],
    )
  })

  test("never mines image URLs from arbitrary tool output", () => {
    expect(
      toolSessionImages(
        completed({
          tool: "bash",
          output: [
            "https://example.com/image.png",
            "http://127.0.0.1:8080/admin.png",
            "http://169.254.169.254/latest/meta-data/iam.png",
          ].join("\n"),
        }),
      ),
    ).toEqual([])

    expect(
      toolSessionImages({
        id: "part_pending",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "tool",
        callID: "call_test",
        tool: "yesmem_execute_cap",
        state: { status: "pending", input: {}, raw: capOutput("https://example.com/image.png") },
      }),
    ).toEqual([])
  })

  test("bounds eager image loading across all mounted tool parts", () => {
    const parts = Array.from({ length: 20 }, (_, index) => ({
      partID: `part_${index}`,
      images: [
        {
          uri: `https://example.com/${index}.png`,
          label: `Image ${index}`,
          source: "output" as const,
        },
      ],
    }))
    const selected = selectAutoSessionImageKeys(parts)

    expect(selected.size).toBe(3)
    expect([...selected]).toEqual(parts.slice(-3).map((part) => sessionImageKey(part.partID, part.images[0]!.uri)))
  })

  test("requires a click before loading remote structured attachments", () => {
    const remote = {
      partID: "part_remote",
      images: [{ uri: "https://example.com/image.png", label: "Remote", source: "attachment" as const }],
    }
    const inline = {
      partID: "part_inline",
      images: [{ uri: "data:image/png;base64,aGVsbG8=", label: "Inline", source: "attachment" as const }],
    }

    expect([...selectAutoSessionImageKeys([remote, inline])]).toEqual([
      sessionImageKey(inline.partID, inline.images[0]!.uri),
    ])
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
