import { describe, expect, test } from "bun:test"
import path from "node:path"
import { symlink, truncate } from "node:fs/promises"
import {
  LOCAL_ATTACHMENT_MAX_BYTES,
  localAttachmentKind,
  readLocalAttachment,
  readLocalAttachmentWith,
} from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"
import { tmpdir } from "../fixture/fixture"

function files(input: { mime: string; text?: string; bytes?: Uint8Array; tooLarge?: boolean }): LocalFiles {
  return {
    mime: async () => input.mime,
    read: async () => {
      if (input.tooLarge) return { type: "too-large" }
      return { type: "content", content: input.bytes ?? new TextEncoder().encode(input.text ?? "") }
    },
  }
}

describe("prompt local attachments", () => {
  test("reads SVG attachments as text", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test.each([
    ["application/msword", "file.doc"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "file.docx"],
    ["application/vnd.ms-excel", "file.xls"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "file.xlsx"],
    ["application/vnd.ms-powerpoint", "file.ppt"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "file.pptx"],
    ["application/vnd.oasis.opendocument.text", "file.odt"],
    ["application/vnd.oasis.opendocument.spreadsheet", "file.ods"],
    ["application/vnd.oasis.opendocument.presentation", "file.odp"],
  ])("reads %s documents as bytes", async (mime, name) => {
    const content = new Uint8Array([80, 75, 3, 4])
    expect(await readLocalAttachmentWith(files({ mime, bytes: content }), `/tmp/${name}`)).toEqual({
      type: "binary",
      mime,
      content,
    })
  })

  test("leaves unknown binary and text-like files on the path-reference flow", async () => {
    expect(
      await readLocalAttachmentWith(
        files({ mime: "application/octet-stream", bytes: new Uint8Array([0, 255, 1, 2]) }),
        "/tmp/file.bin",
      ),
    ).toBeUndefined()
    expect(await readLocalAttachmentWith(files({ mime: "video/mp2t" }), "/tmp/main.ts")).toBeUndefined()
  })

  test("keeps text and structured text files on the path-reference flow", async () => {
    expect(
      await readLocalAttachmentWith(files({ mime: "text/plain", tooLarge: true }), "/tmp/file.txt"),
    ).toBeUndefined()
    expect(await readLocalAttachmentWith(files({ mime: "application/json" }), "/tmp/file.json")).toBeUndefined()
    expect(await readLocalAttachmentWith(files({ mime: "application/rtf" }), "/tmp/file.rtf")).toBeUndefined()
  })

  test("rejects oversized and unreadable local files", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", tooLarge: true }), "/tmp/large.pdf")).toEqual(
      { type: "error", reason: "too-large", maxBytes: LOCAL_ATTACHMENT_MAX_BYTES },
    )
    expect(
      await readLocalAttachmentWith(
        {
          ...files({ mime: "image/png" }),
          read: async () => Promise.reject(new Error("missing")),
        },
        "/tmp/missing.png",
      ),
    ).toBeUndefined()
  })

  test("detects document MIME types from real local paths", async () => {
    await using tmp = await tmpdir()
    const content = new Uint8Array([80, 75, 3, 4])
    const attachments = [
      ["file.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["file.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["file.odt", "application/vnd.oasis.opendocument.text"],
      ["file.PDF", "application/pdf"],
      ["file.PNG", "image/png"],
    ]
    for (const [name, mime] of attachments) {
      const file = path.join(tmp.path, name)
      await Bun.write(file, content)
      expect(await readLocalAttachment(file)).toMatchObject({ type: "binary", mime, content })
    }
  })

  test("bounds real reads and ignores special files", async () => {
    await using tmp = await tmpdir()
    const large = path.join(tmp.path, "large.pdf")
    await Bun.write(large, "")
    await truncate(large, LOCAL_ATTACHMENT_MAX_BYTES + 1)
    expect(await readLocalAttachment(large)).toEqual({
      type: "error",
      reason: "too-large",
      maxBytes: LOCAL_ATTACHMENT_MAX_BYTES,
    })

    if (process.platform !== "linux") return
    const device = path.join(tmp.path, "device.pdf")
    await symlink("/dev/zero", device)
    expect(await readLocalAttachment(device)).toBeUndefined()
  })

  test("classifies placeholders independently", () => {
    expect(localAttachmentKind("image/png")).toBe("image")
    expect(localAttachmentKind("application/pdf")).toBe("pdf")
    expect(localAttachmentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("file")
    expect(localAttachmentKind("application/octet-stream")).toBe("file")
  })
})
