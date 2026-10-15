import { beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

// The draft stash is module-global; a disposed prompt leaves its draft behind.
beforeEach(() => {
  takeDraft(undefined)
  takeDraft("ses_test")
})

// E6 follow-up: v1 bound bare Home to both transcript navigation (messages_first)
// and the input buffer (input_buffer_home); our fork made the buffer win while
// the composer was focused. v2 resolves the same collision upstream instead:
// input.buffer.home/end are unbound, Home/End navigate the transcript, and
// ctrl+a/ctrl+e (input.line.home/end) own the buffer. The first test locks that
// default mapping by switching the built-in `opencode.prompt.home-end` plugin off
// through config (the documented kill switch: a `-<plugin id>` entry in the TUI
// config's `plugins` list). The second test pins the plugin itself: Home/End move
// the composer buffer while ctrl+g/ctrl+alt+g still jump the transcript.

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

test("with the plugin switched off Home navigates the transcript while ctrl+a stays in the focused composer", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, tabs: { mode: "off" }, plugins: ["-opencode.prompt.home-end"] },
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
}, 30_000)

test("the built-in prompt-home-end plugin moves the composer buffer and leaves ctrl+g on the transcript", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, tabs: { mode: "off" } },
    args: { sessionID: "ses_test" },
    fetch,
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("History message 0399"))

  await setup.mockInput.typeText("draft")
  await setup.waitForFrame((frame) => frame.includes("draft"))

  // The plugin reconciles asynchronously; Home stops jumping the transcript once
  // its layer is live. Probe until then, restoring the bottom between attempts.
  await setup.waitFor(async () => {
    setup.mockInput.pressKey("HOME")
    await setup.renderOnce()
    const stayed = setup.captureCharFrame().includes("History message 0399")
    if (!stayed) {
      setup.mockInput.pressKey("END")
      await setup.renderOnce()
    }
    return stayed
  })

  const editor = setup.renderer.currentFocusedEditor as { cursorOffset: number } | null

  setup.mockInput.pressKey("HOME")
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toContain("History message 0399")
  expect(editor?.cursorOffset).toBe(0)

  setup.mockInput.pressKey("END")
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toContain("History message 0399")
  expect(editor?.cursorOffset).toBe("draft".length)

  // ctrl+g (session.first) still reaches the transcript.
  setup.mockInput.pressKey("g", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("History message 0000"))
}, 30_000)
