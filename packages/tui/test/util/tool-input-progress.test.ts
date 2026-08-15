import { describe, expect, test } from "bun:test"
import { toolInputProgress } from "../../src/util/tool-input-progress"

describe("toolInputProgress", () => {
  test("keeps the base label until input starts", () => {
    expect(toolInputProgress("Preparing write...")).toBe("Preparing write...")
    expect(toolInputProgress("Preparing write...", 0)).toBe("Preparing write...")
  })

  test("formats received input without retaining its content", () => {
    expect(toolInputProgress("Preparing write...", 512)).toBe("Preparing write... (512 B received)")
    expect(toolInputProgress("Preparing write...", 1536)).toBe("Preparing write... (1.5 KB received)")
    expect(toolInputProgress("Preparing write...", 1024 * 1024)).toBe("Preparing write... (1 MB received)")
  })
})
