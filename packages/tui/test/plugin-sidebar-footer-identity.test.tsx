/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { Host } from "@opencode/plugin/host"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotPath } from "@opencode/plugin/tui/context"
import "../src/plugin/runtime-plugin-support.bun"

const identitySlot: SlotPath = "sidebar.footer"

const entry = new URL("../../../.opencode/plugin-suite/sidebar-footer/tui.tsx", import.meta.url)

type IdentityModule = {
  default: Plugin.Definition
  SidebarIdentity: (props: { context: Plugin.Context; sessionID: string }) => JSX.Element
}

function context(version: string) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    app: { version, channel: "dev" },
    theme: {
      text: { base: color, muted: color, feedback: { success: { base: color } } },
    },
  } as unknown as Plugin.Context
}

describe("sidebar footer identity plugin", () => {
  test("loads as an external plugin module through the host loader", async () => {
    const module = (await Host.load(entry.href)) as IdentityModule
    expect(module.default.id).toBe("opencode.sidebar.footer.identity")
    expect(typeof module.default.setup).toBe("function")
  })

  test("appends its content to the sidebar footer slot", async () => {
    const module = (await Host.load(entry.href)) as IdentityModule
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
    expect(claim?.append).toBe(identitySlot)
    expect(typeof claim?.render).toBe("function")
  })

  test("renders the OpenCode version and the session id", async () => {
    const module = (await Host.load(entry.href)) as IdentityModule
    const app = await testRender(
      () => (
        <box width={38}>
          <module.SidebarIdentity context={context("2.0.26")} sessionID="ses_abc123" />
        </box>
      ),
      { width: 38, height: 6 },
    )
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("OpenCode")
      expect(frame).toContain("2.0.26")
      expect(frame).toContain("ses_abc123")
    } finally {
      app.renderer.destroy()
    }
  })
})
