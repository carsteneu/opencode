/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import "../src/plugin/runtime-plugin-support.bun"
import { builtins } from "../src/plugin/builtins"
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

/**
 * A plugin directory holding a copy of the built-in tokens-per-second plugin: same id, same slot claim,
 * but a marker of its own instead of the tok/s cell. This is what a leftover copy in the user's plugin
 * directory looks like to the TUI.
 */
async function leftoverCopy() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-duplicate-tui-plugin-"))
  await writeFile(
    path.join(root, "tui.tsx"),
    `/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode.prompt.tokens-per-second",
  setup(context) {
    context.ui.slot({ append: "prompt.footer", render: () => <text>leftover-copy-cell</text> })
  },
})
`,
  )
  return root
}

test("the fork plugins are registered as built-ins", () => {
  const ids = builtins.map((plugin) => plugin.id)
  expect(ids).toContain("opencode.prompt.home-end")
  expect(ids).toContain("opencode.prompt.tokens-per-second")
  expect(ids).toContain("opencode.sidebar.footer.identity")
  expect(ids).toContain("opencode.sidebar.title.rename")
  // Unique ids: a duplicate would claim every slot twice.
  expect(new Set(ids).size).toBe(ids.length)
})

test("a leftover copy of a built-in plugin does not render twice", async () => {
  const root = await leftoverCopy()
  try {
    await using setup = await createAppFixture({
      config: { animations: false, tabs: { mode: "off" }, plugins: [root] },
      args: { sessionID: "ses_test" },
      fetch,
    })
    await setup.ready
    await Bun.sleep(3500)
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    const builtinCell = frame.includes("out ~")
    const copyCell = frame.includes("leftover-copy-cell")
    // Exactly one of the two renders: a duplicate id never produces a second cell.
    expect(builtinCell !== copyCell).toBe(true)
    // Measured precedence: the desired generation is keyed by plugin id, so the leftover copy replaces the
    // built-in entry and wins while it is installed. The built-in takes over only once the copy is gone,
    // which is why the plugin directory has to be cleaned up after the upgrade.
    expect(copyCell).toBe(true)
    expect(builtinCell).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
