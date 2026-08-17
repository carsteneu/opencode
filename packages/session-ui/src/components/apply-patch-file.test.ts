import { describe, expect, test } from "bun:test"
import { patchFiles } from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("keeps patchless files with finite statistics as empty diff summaries", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/large.ts",
        relativePath: "large.ts",
        type: "update",
        additions: 12,
        deletions: 7,
      },
    ])[0]

    expect(file).toMatchObject({
      filePath: "/tmp/large.ts",
      relativePath: "large.ts",
      type: "update",
      additions: 12,
      deletions: 7,
    })
    expect(file?.view.fileDiff.name).toBe("large.ts")
    expect(text(file!.view, "deletions")).toBe("")
    expect(text(file!.view, "additions")).toBe("")
    expect(
      patchFiles([
        {
          filePath: "/tmp/malformed.ts",
          relativePath: "malformed.ts",
          type: "update",
          additions: 1,
          deletions: Number.NaN,
        },
      ]),
    ).toEqual([])
  })
})
