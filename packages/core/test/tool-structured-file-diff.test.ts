import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { StructuredFileDiff } from "@opencode-ai/core/tool/structured-file-diff"

const file = (name: string, patch?: string) => ({
  file: name,
  patch,
  additions: 1,
  deletions: 0,
  status: "added" as const,
})

const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value))

describe("StructuredFileDiff", () => {
  test("preserves small patch arrays byte-for-byte", () => {
    const files = [file("first.txt", "@@ -0,0 +1 @@\n+first\n"), file("metadata-only.txt")]

    expect(StructuredFileDiff.bound(files)).toBe(files)
  })

  test("retains an exact-budget patch and drops it at one byte over", () => {
    const exact = "x".repeat(StructuredFileDiff.MAX_PATCH_BYTES - jsonBytes(""))
    expect(jsonBytes(exact)).toBe(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(StructuredFileDiff.bound([file("exact.txt", exact)])[0]?.patch).toBe(exact)

    const source = [file("over.txt", `${exact}x`)]
    expect(StructuredFileDiff.bound(source)).toEqual([{ ...source[0], patch: undefined }])
    expect(source[0]?.patch).toBe(`${exact}x`)
  })

  test("uses one all-or-none budget across multiple individually valid patches", () => {
    const first = "a".repeat(32 * 1024)
    const second = "b".repeat(StructuredFileDiff.MAX_PATCH_BYTES - jsonBytes(first) - jsonBytes("") - 1)
    expect(jsonBytes(first)).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(jsonBytes(second)).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(jsonBytes(first) + jsonBytes(second)).toBe(StructuredFileDiff.MAX_PATCH_BYTES - 1)

    const exact = [file("first.txt", first), file("second.txt", `${second}x`), file("without.txt")]
    expect(jsonBytes(exact[0]!.patch!) + jsonBytes(exact[1]!.patch!)).toBe(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(StructuredFileDiff.bound(exact)).toBe(exact)

    const over = [file("first.txt", first), file("second.txt", `${second}xx`), file("without.txt")]
    expect(jsonBytes(over[0]!.patch!)).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(jsonBytes(over[1]!.patch!)).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(StructuredFileDiff.bound(over)).toEqual(over.map((item) => ({ ...item, patch: undefined })))
  })

  test("matches JSON UTF-8 costs for escapes, controls, astral characters, and lone surrogates", () => {
    const prefix = `"\\\b\t\n\f\r\u0000\u001f/é€😀\ud800h\udc00l`
    const exact = `${prefix}${"x".repeat(StructuredFileDiff.MAX_PATCH_BYTES - jsonBytes(prefix))}`

    expect(exact.length).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(jsonBytes(exact)).toBe(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(StructuredFileDiff.bound([file("unicode.txt", exact)])[0]?.patch).toBe(exact)
    expect(StructuredFileDiff.bound([file("unicode.txt", `${exact}x`)])[0]?.patch).toBeUndefined()
  })

  test("retains legacy Edit and ApplyPatch strings through Success event encoding", () => {
    const patch = "@@ -1 +1 @@\n-before\n+after\n"
    const values = [
      { replacements: 1, files: [file("edit.txt", patch)] },
      {
        applied: [{ type: "update", resource: "apply.txt", target: "/workspace/apply.txt" }],
        files: [{ ...file("apply.txt", patch), status: "modified" }],
      },
    ]

    for (const structured of values) {
      const encoded = Schema.encodeSync(SessionEvent.Tool.Success.data)(
        Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
          sessionID: SessionV2.ID.make("ses_structured_file_diff_legacy"),
          timestamp: Date.now(),
          assistantMessageID: SessionMessage.ID.make("msg_structured_file_diff_legacy"),
          callID: "call-legacy",
          structured,
          content: [{ type: "text", text: "complete" }],
          provider: { executed: false },
        }),
      )
      expect(encoded.structured).toEqual(structured)
      expect(JSON.stringify(encoded).split(JSON.stringify(patch).slice(1, -1))).toHaveLength(2)
    }
  })
})
