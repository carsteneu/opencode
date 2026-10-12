/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "node:path"
import { Host } from "@opencode/plugin/host"
import type { Plugin } from "@opencode/plugin/tui"
import "../src/plugin/runtime-plugin-support.bun"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

const pluginDirectory = path.join(import.meta.dir, "../../../.opencode/plugin-suite/tokens-per-second")
const pluginEntry = new URL("../../../.opencode/plugin-suite/tokens-per-second/tui.tsx", import.meta.url)

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

test(
  "renders a client-side tok/s estimate from text deltas and hides it when the stream stops",
  async () => {
    await using setup = await createAppFixture({
      config: { animations: false, tabs: { mode: "off" }, plugins: [pluginDirectory] },
      args: { sessionID: "ses_test" },
      fetch,
    })
    await setup.ready
    // Session load plus the ~3s startup overlay that covers the footer.
    await Bun.sleep(3500)
    await setup.renderOnce()

    // Feed deltas until the plugin's slot is live and the cell appears.
    await setup.waitFor(
      async () => {
        setup.events.emit(delta("assistant output chunk "))
        await Bun.sleep(60)
        await setup.renderOnce()
        return setup.captureCharFrame().includes("tk/s")
      },
      { maxPasses: 100 },
    )
    expect(setup.captureCharFrame()).toMatch(/out ~\d+ tk\/s/)

    // No further deltas: the sliding window empties and the cell disappears.
    await Bun.sleep(2200)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("tk/s")
  },
  30_000,
)

test("loads as an external plugin that appends to the prompt footer", async () => {
  const module = (await Host.load(pluginEntry.href)) as { default: Plugin.Definition }
  expect(module.default.id).toBe("opencode.prompt.tokens-per-second")
  let claim: { append?: string; render?: unknown } | undefined
  const fake = {
    ui: {
      slot: (value: { append: string; render: unknown }) => {
        claim = value
        return () => {}
      },
    },
  } as unknown as Plugin.Context
  await module.default.setup(fake)
  expect(claim?.append).toBe("prompt.footer")
  expect(typeof claim?.render).toBe("function")
})
