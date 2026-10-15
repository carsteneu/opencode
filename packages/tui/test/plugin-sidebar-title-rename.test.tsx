/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotPath } from "@opencode/plugin/tui/context"
import RenamePencil, { SessionRenamePencil } from "../src/feature-plugins/sidebar/title-rename"

const actionsSlot: SlotPath = "sidebar.title.actions"

type Recorded = {
  answer?: string
  prompt?: { title: string; placeholder?: string; value?: string }
  updates: Array<{ sessionID: string; title?: string }>
}

function record(answer?: string): Recorded {
  return { answer, updates: [] }
}

function context(record: Recorded) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: { text: { base: color, muted: color } },
    ui: {
      dialog: {
        prompt: (options: { title: string; placeholder?: string; value?: string }) => {
          record.prompt = options
          return Promise.resolve(record.answer)
        },
      },
      toast: { show: () => {} },
    },
    client: {
      session: {
        update: (value: { sessionID: string; title?: string }) => {
          record.updates.push(value)
          return Promise.resolve()
        },
      },
    },
  } as unknown as Plugin.Context
}

async function renderPencil(record: Recorded, title = "Fix broken tests") {
  const app = await testRender(
    () => (
      <box width={38}>
        <SessionRenamePencil context={context(record)} sessionID="ses_abc123" title={title} />
      </box>
    ),
    { width: 38, height: 3 },
  )
  await app.renderOnce()
  return app
}

async function click(app: Awaited<ReturnType<typeof renderPencil>>) {
  const pencil = app.renderer.root.findDescendantById("sidebar.title.rename")
  if (!pencil) throw new Error("pencil not rendered")
  await app.mockMouse.click(pencil.x, pencil.y)
  await app.renderOnce()
}

describe("sidebar title rename pencil plugin", () => {
  test("ships as a built-in plugin definition that claims the sidebar title actions slot", async () => {
    expect(RenamePencil.id).toBe("opencode.sidebar.title.rename")
    let placed: { append?: string } | undefined
    const fake = {
      ui: {
        slot: (value: { append: string }) => {
          placed = value
          return () => {}
        },
      },
    } as unknown as Plugin.Context
    await RenamePencil.setup(fake)
    expect(placed?.append).toBe(actionsSlot)
  })

  test("prompts with the current title and renames to the trimmed value", async () => {
    const rec = record("  Renamed session  ")
    const app = await renderPencil(rec)
    try {
      await click(app)
      expect(rec.prompt).toEqual({
        title: "Rename session",
        placeholder: "Session title",
        value: "Fix broken tests",
      })
      expect(rec.updates).toEqual([{ sessionID: "ses_abc123", title: "Renamed session" }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores a cancelled or blank rename", async () => {
    const cancelled = record()
    const blank = record("   ")
    const first = await renderPencil(cancelled)
    const second = await renderPencil(blank)
    try {
      await click(first)
      await click(second)
      expect(cancelled.updates).toEqual([])
      expect(blank.updates).toEqual([])
    } finally {
      first.renderer.destroy()
      second.renderer.destroy()
    }
  })
})
