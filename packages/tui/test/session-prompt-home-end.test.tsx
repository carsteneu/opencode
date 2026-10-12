import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

// E6 verification: v1 bound bare Home to both transcript navigation
// (messages_first) and the input buffer (input_buffer_home); our fork made the
// buffer win while the composer was focused. v2 resolves the same collision
// upstream instead: input.buffer.home/end are unbound, Home/End navigate the
// transcript, and ctrl+a/ctrl+e (input.line.home/end) own the buffer. This test
// locks that mapping so a silent rebind shows up as a failure.

const session = {
  id: "ses_test",
  title: "Long history",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const messages = Array.from({ length: 400 }, (_, index) => ({
  id: `message-${index}`,
  type: "user",
  text: `History message ${String(index).padStart(4, "0")}`,
  time: { created: index },
}))

const fetch: FetchHandler = (url) => {
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/session/ses_test") return json({ data: session })
  if (url.pathname === "/api/session/ses_test/message") {
    const end = Number(url.searchParams.get("cursor") ?? messages.length)
    const limit = Number(url.searchParams.get("limit"))
    const start = Math.max(0, end - limit)
    return json({ data: messages.slice(start, end).toReversed(), cursor: end ? { next: String(start) } : {} })
  }
  if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
  if (url.pathname === "/api/session/ses_test/permission") return json({ data: [] })
  return undefined
}

test(
  "Home navigates the transcript while ctrl+a stays in the focused composer",
  async () => {
    await using setup = await createAppFixture({
      config: { animations: false, tabs: { mode: "off" } },
      args: { sessionID: "ses_test" },
      fetch,
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("History message 0399"))

    // A typed draft proves the composer holds focus for the following keys.
    await setup.mockInput.typeText("draft")
    await setup.waitForFrame((frame) => frame.includes("draft"))

    setup.mockInput.pressKey("HOME")
    await setup.waitForFrame((frame) => frame.includes("History message 0000"))
    expect(setup.captureCharFrame()).toContain("draft")

    // Back to the bottom, so the next assertion can actually observe a jump.
    setup.mockInput.pressKey("END")
    await setup.waitForFrame((frame) => frame.includes("History message 0399"))

    // ctrl+a is input.line.home: a buffer move, so the transcript stays put.
    setup.mockInput.pressKey("a", { ctrl: true })
    await setup.waitForVisualIdle()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("History message 0399")
    expect(frame).toContain("draft")
  },
  30_000,
)
