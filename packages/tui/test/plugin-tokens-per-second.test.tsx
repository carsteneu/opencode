/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import TokensPerSecond from "../src/feature-plugins/prompt/tokens-per-second"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

const session = {
  id: "ses_test",
  title: "Streaming",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const fetch: FetchHandler = (url) => {
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/session/ses_test") return json({ data: session })
  if (url.pathname === "/api/session/ses_test/message") return json({ data: [], cursor: {} })
  if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
  if (url.pathname === "/api/session/ses_test/permission") return json({ data: [] })
  return undefined
}

let sequence = 0
function delta(text: string) {
  sequence += 1
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type: "session.text.delta",
    data: { sessionID: "ses_test", assistantMessageID: "msg_1", ordinal: 0, delta: text },
  } as never
}

// Reasoning streams over its own event in v2, so a meter wired to the text event alone
// reads 0 for a model that is only thinking.
function reasoning(text: string) {
  sequence += 1
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type: "session.reasoning.delta",
    data: { sessionID: "ses_test", assistantMessageID: "msg_1", ordinal: 0, delta: text },
  } as never
}

test("renders a client-side tok/s estimate from text deltas and keeps the cell at 0 when the stream stops", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, tabs: { mode: "off" } },
    args: { sessionID: "ses_test" },
    fetch,
  })
  await setup.ready
  // Session load plus the ~3s startup overlay that covers the footer.
  await Bun.sleep(3500)
  await setup.renderOnce()

  // The cell is permanent, exactly like v1's footer: idle it reads 0.
  expect(setup.captureCharFrame()).toMatch(/out ~0 tk\/s/)

  // Feed deltas until the meter reads a live rate.
  await setup.waitFor(
    async () => {
      setup.events.emit(delta("assistant output chunk "))
      await Bun.sleep(60)
      await setup.renderOnce()
      return /out ~[1-9]\d* tk\/s/.test(setup.captureCharFrame())
    },
    { maxPasses: 100 },
  )

  // No further deltas: the sliding window empties and the cell falls back to 0.
  await Bun.sleep(2200)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toMatch(/out ~0 tk\/s/)
}, 30_000)

test("counts reasoning deltas in the output rate", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, tabs: { mode: "off" } },
    args: { sessionID: "ses_test" },
    fetch,
  })
  await setup.ready
  await Bun.sleep(3500)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toMatch(/out ~0 tk\/s/)

  // Only thinking, no answer text yet: the cell still has to move.
  await setup.waitFor(
    async () => {
      setup.events.emit(reasoning("thinking about the answer "))
      await Bun.sleep(60)
      await setup.renderOnce()
      return /out ~[1-9]\d* tk\/s/.test(setup.captureCharFrame())
    },
    { maxPasses: 100 },
  )
}, 30_000)

test("ships as a built-in plugin that appends to the prompt footer", async () => {
  expect(TokensPerSecond.id).toBe("opencode.prompt.tokens-per-second")
  let claim: { append?: string; render?: unknown } | undefined
  const fake = {
    ui: {
      slot: (value: { append: string; render: unknown }) => {
        claim = value
        return () => {}
      },
    },
  } as unknown as Plugin.Context
  await TokensPerSecond.setup(fake)
  expect(claim?.append).toBe("prompt.footer")
  expect(typeof claim?.render).toBe("function")
})
