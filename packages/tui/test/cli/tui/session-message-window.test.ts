import { describe, expect, test } from "bun:test"
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { projectMessageWindow, shouldExpandMessageWindow } from "../../../src/routes/session"

function user(index: number) {
  return {
    id: `message-${index.toString().padStart(2, "0")}`,
    role: "user" as const,
    time: { created: index },
  }
}

function assistant(index: number, completed = true) {
  return {
    id: `message-${index.toString().padStart(2, "0")}`,
    role: "assistant" as const,
    time: {
      created: index,
      ...(completed ? { completed: index + 1 } : {}),
    },
  }
}

describe("session message window", () => {
  test("renders only the newest 10 messages and reports the hidden prefix", () => {
    const messages = Array.from({ length: 12 }, (_, index) => user(index))
    const projection = projectMessageWindow(messages, 10)

    expect(projection.projected).toEqual(messages)
    expect(projection.visible.map((message) => message.id)).toEqual(messages.slice(2).map((message) => message.id))
    expect(projection.hidden).toBe(2)
  })

  test("projects a revert marker before applying a window that originally excluded it", () => {
    const messages = Array.from({ length: 25 }, (_, index) => user(index))
    const revertMessageID = messages[12].id

    expect(messages.slice(-10).some((message) => message.id === revertMessageID)).toBeFalse()

    const projection = projectMessageWindow(messages, 10, revertMessageID)

    expect(projection.projected.map((message) => message.id)).toEqual(
      messages.slice(0, 13).map((message) => message.id),
    )
    expect(projection.visible.map((message) => message.id)).toEqual(messages.slice(3, 13).map((message) => message.id))
    expect(projection.visible.at(-1)?.id).toBe(revertMessageID)
    expect(projection.hidden).toBe(3)
    expect(projection.revertIndex).toBe(12)
  })

  test("marks a prompt queued by global order instead of its local window index", () => {
    const messages = [
      ...Array.from({ length: 9 }, (_, index) => assistant(index)),
      user(9),
      assistant(10, false),
      user(11),
    ]
    const projection = projectMessageWindow(messages, 10)
    const queued = messages.at(-1)!

    expect(messages.findIndex((message) => message.id === "message-10")).toBe(10)
    expect(projection.visible.findIndex((message) => message.id === queued.id)).toBe(9)
    expect(projection.queued.has("message-09")).toBeFalse()
    expect(projection.queued.has(queued.id)).toBeTrue()
  })

  test("restores an image message beyond the newest 10 messages when the window expands", () => {
    const imageMessage = assistant(0)
    const messages = [imageMessage, ...Array.from({ length: 9 }, (_, index) => user(index + 1))]

    expect(projectMessageWindow(messages, 10).visible[0]).toBe(imageMessage)

    const next = [...messages, user(10)]
    expect(projectMessageWindow(next, 10).visible).not.toContain(imageMessage)
    expect(projectMessageWindow(next, 30).visible).toContain(imageMessage)
  })

  test("expands an underfilled ScrollBox while a hidden prefix remains", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30, useThread: false })
    const scroll = new ScrollBoxRenderable(setup.renderer, { width: 80, height: 20 })
    setup.renderer.root.add(scroll)

    try {
      for (let index = 0; index < 10; index++) {
        scroll.add(new BoxRenderable(setup.renderer, { height: 1 }))
      }
      await setup.renderOnce()

      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.height)
      expect(shouldExpandMessageWindow(90, scroll.scrollHeight, scroll.height)).toBeTrue()
      expect(shouldExpandMessageWindow(0, scroll.scrollHeight, scroll.height)).toBeFalse()
      expect(shouldExpandMessageWindow(90, 0, 0)).toBeFalse()

      for (let index = 10; index < 30; index++) {
        scroll.add(new BoxRenderable(setup.renderer, { height: 1 }))
      }
      await setup.renderOnce()

      expect(scroll.scrollHeight).toBeGreaterThan(scroll.height)
      expect(shouldExpandMessageWindow(70, scroll.scrollHeight, scroll.height)).toBeFalse()
    } finally {
      setup.renderer.destroy()
    }
  })
})
