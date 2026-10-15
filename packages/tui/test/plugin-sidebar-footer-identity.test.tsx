/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotPath } from "@opencode/plugin/tui/context"
import Identity, { SidebarIdentity } from "../src/feature-plugins/sidebar/footer-identity"

const identitySlot: SlotPath = "sidebar.footer"

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
  test("ships as a built-in plugin definition", () => {
    expect(Identity.id).toBe("opencode.sidebar.footer.identity")
    expect(typeof Identity.setup).toBe("function")
  })

  test("appends its content to the sidebar footer slot", async () => {
    let claim: { append?: string; render?: unknown } | undefined
    const fake = {
      ui: {
        slot: (value: { append: string; render: unknown }) => {
          claim = value
          return () => {}
        },
      },
    } as unknown as Plugin.Context
    await Identity.setup(fake)
    expect(claim?.append).toBe(identitySlot)
    expect(typeof claim?.render).toBe("function")
  })

  test("renders the OpenCode version and the session id", async () => {
    const app = await testRender(
      () => (
        <box width={38}>
          <SidebarIdentity context={context("2.0.26")} sessionID="ses_abc123" />
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
