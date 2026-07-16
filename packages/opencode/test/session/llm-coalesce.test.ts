import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { coalesceDeltas } from "../../src/session/llm"

describe("coalesceDeltas", () => {
  test("joins adjacent text and reasoning deltas", () => {
    const events = coalesceDeltas([
      LLMEvent.textDelta({ id: "text", text: "hel" }),
      LLMEvent.textDelta({ id: "text", text: "lo" }),
      LLMEvent.reasoningDelta({ id: "reasoning", text: "one" }),
      LLMEvent.reasoningDelta({ id: "reasoning", text: " two" }),
    ])

    expect(events).toEqual([
      LLMEvent.textDelta({ id: "text", text: "hello" }),
      LLMEvent.reasoningDelta({ id: "reasoning", text: "one two" }),
    ])
  })

  test("preserves boundaries and event order", () => {
    const events = [
      LLMEvent.textStart({ id: "first" }),
      LLMEvent.textDelta({ id: "first", text: "a" }),
      LLMEvent.textDelta({ id: "second", text: "b" }),
      LLMEvent.textDelta({ id: "first", text: "c" }),
      LLMEvent.textEnd({ id: "first" }),
    ]

    expect(coalesceDeltas(events)).toEqual(events)
  })

  test("keeps the latest available provider metadata", () => {
    const first = { openai: { itemId: "first" } }
    const latest = { openai: { itemId: "latest" } }
    const events = coalesceDeltas([
      LLMEvent.textDelta({ id: "text", text: "a", providerMetadata: first }),
      LLMEvent.textDelta({ id: "text", text: "b" }),
      LLMEvent.textDelta({ id: "text", text: "c", providerMetadata: latest }),
    ])

    expect(events).toEqual([LLMEvent.textDelta({ id: "text", text: "abc", providerMetadata: latest })])
  })
})
