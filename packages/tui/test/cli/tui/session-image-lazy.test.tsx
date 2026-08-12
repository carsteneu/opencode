import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { SessionToolImages } from "../../../src/routes/session"

const part: ToolPart = {
  id: "part_tool",
  sessionID: "ses_test",
  messageID: "msg_test",
  type: "tool",
  callID: "call_test",
  tool: "image",
  state: {
    status: "completed",
    input: {},
    output: "No image was generated.",
    title: "Generate image",
    metadata: {},
    time: { start: 1, end: 2 },
  },
}

test("tool parts without images do not subscribe to terminal resize events", async () => {
  const app = await testRender(() => <SessionToolImages part={part} />, {
    width: 80,
    height: 24,
    useThread: false,
  })

  try {
    await app.renderOnce()
    expect(app.renderer.listenerCount("resize")).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
