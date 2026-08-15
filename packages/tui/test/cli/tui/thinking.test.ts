import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { reasoningSummary, renderedAssistantParts } from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })
})

describe("renderedAssistantParts", () => {
  test("removes reasoning before the hidden render path", () => {
    const parts = [
      { type: "reasoning", text: "private" },
      { type: "text", text: "answer" },
    ]

    expect(renderedAssistantParts(parts, "hide")).toEqual([{ type: "text", text: "answer" }])
    expect(renderedAssistantParts(parts, "show")).toBe(parts)
  })

  test("does not react to hidden reasoning text deltas", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        parts: [
          { type: "reasoning", text: "first" },
          { type: "text", text: "answer" },
        ],
      })
      let runs = 0
      const rendered = createMemo(() => {
        runs += 1
        return renderedAssistantParts(store.parts, "hide")
      })

      expect(rendered()).toHaveLength(1)
      expect(runs).toBe(1)
      setStore("parts", 0, "text", "second")
      expect(rendered()).toHaveLength(1)
      expect(runs).toBe(1)
      dispose()
    })
  })
})
