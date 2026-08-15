/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import renameButton from "../../src/feature-plugins/sidebar/rename-button"
import { createTuiPluginApi } from "../fixture/tui-plugin"

type Registered = { order: number; slots: Record<string, (ctx: unknown, props: { session_id: string }) => unknown> }
type Slots = {
  sidebar_title_actions: { session_id: string }
}
const meta = { id: "internal:sidebar-rename" } as never

test("registers the sidebar_title_actions slot", async () => {
  const api = createTuiPluginApi()
  let registered: Registered | undefined
  ;(api as unknown as { slots: unknown }).slots = {
    register: (plugin: Registered) => {
      registered = plugin
    },
  }

  await renameButton.tui(api, undefined, meta)

  expect(registered).toBeDefined()
  expect(registered!.order).toBeTypeOf("number")
  expect(typeof registered!.slots.sidebar_title_actions).toBe("function")
})

test("renders the pencil action for a session", async () => {
  const api = createTuiPluginApi()
  let registered: Registered | undefined
  ;(api as unknown as { slots: unknown }).slots = {
    register: (plugin: Registered) => {
      registered = plugin
    },
  }

  await renameButton.tui(api, undefined, meta)

  const App = () => {
    const registry = createSolidSlotRegistry<Slots>(useRenderer(), {})
    const Slot = createSlot(registry)
    registry.register({
      id: "internal:sidebar-rename",
      slots: registered!.slots as never,
    })
    return <Slot name="sidebar_title_actions" session_id="session-1" />
  }

  const app = await testRender(() => <App />)
  try {
    await app.waitForFrame((frame) => frame.includes("✎"))
  } finally {
    app.renderer.destroy()
  }
})
