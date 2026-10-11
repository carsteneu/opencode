import { expect, test } from "bun:test"
import { batch, createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionMessageInfo } from "../src/promise"

type Listener = Parameters<CreateDataInput["event"]["listen"]>[0]

const sessionID = "ses_stream"
const messageID = "msg_assistant"

function fixture() {
  const listeners = new Set<Listener>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => Response.json({ data: [], cursor: {} }),
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  return {
    ...setup,
    // Mirrors connection.publish(): one dispatch batch, then the deferred flush.
    publish(...events: OpenCodeEvent[]) {
      batch(() =>
        events.forEach((details) => listeners.forEach((listener) => listener({ name: details.type, details }))),
      )
    },
  }
}

const stepStarted = (): OpenCodeEvent => ({
  id: "evt_step",
  created: 1,
  type: "session.step.started",
  durable: { aggregateID: sessionID, seq: 1, version: 1 },
  data: {
    sessionID,
    assistantMessageID: messageID,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    started: 1,
  },
})

const textStarted = (ordinal = 0): OpenCodeEvent => ({
  id: `evt_text_started_${ordinal}`,
  created: 2,
  type: "session.text.started",
  durable: { aggregateID: sessionID, seq: 2, version: 1 },
  data: { sessionID, assistantMessageID: messageID, ordinal },
})

const textDelta = (delta: string, ordinal = 0): OpenCodeEvent => ({
  id: `evt_text_delta_${delta}`,
  created: 3,
  type: "session.text.delta",
  data: { sessionID, assistantMessageID: messageID, ordinal, delta },
})

const textEnded = (text: string, ordinal = 0): OpenCodeEvent => ({
  id: `evt_text_ended_${ordinal}`,
  created: 4,
  type: "session.text.ended",
  durable: { aggregateID: sessionID, seq: 3, version: 1 },
  data: { sessionID, assistantMessageID: messageID, ordinal, text },
})

const reasoningStarted = (): OpenCodeEvent => ({
  id: "evt_reasoning_started",
  created: 2,
  type: "session.reasoning.started",
  durable: { aggregateID: sessionID, seq: 2, version: 1 },
  data: { sessionID, assistantMessageID: messageID, ordinal: 0 },
})

const reasoningDelta = (delta: string): OpenCodeEvent => ({
  id: `evt_reasoning_delta_${delta}`,
  created: 3,
  type: "session.reasoning.delta",
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
})

const reasoningEnded = (text: string): OpenCodeEvent => ({
  id: "evt_reasoning_ended",
  created: 4,
  type: "session.reasoning.ended",
  durable: { aggregateID: sessionID, seq: 3, version: 1 },
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, text },
})

const toolID = "call_edit"

const toolInputStarted = (): OpenCodeEvent => ({
  id: "evt_tool_started",
  created: 2,
  type: "session.tool.input.started",
  durable: { aggregateID: sessionID, seq: 2, version: 1 },
  data: { sessionID, assistantMessageID: messageID, id: toolID, name: "edit" },
})

const toolInputDelta = (delta: string): OpenCodeEvent => ({
  id: `evt_tool_delta_${delta}`,
  created: 3,
  type: "session.tool.input.delta",
  data: { sessionID, assistantMessageID: messageID, id: toolID, delta },
})

const toolInputEnded = (text: string): OpenCodeEvent => ({
  id: "evt_tool_ended",
  created: 4,
  type: "session.tool.input.ended",
  durable: { aggregateID: sessionID, seq: 3, version: 1 },
  data: { sessionID, assistantMessageID: messageID, id: toolID, text },
})

function assistant(messages: SessionMessageInfo[]): Extract<SessionMessageInfo, { type: "assistant" }> | undefined {
  const item = messages.findLast((message) => message.id === messageID)
  return item?.type === "assistant" ? item : undefined
}

function text(setup: ReturnType<typeof fixture>) {
  const item = assistant(setup.data.session.message.list(sessionID))
  const part = item?.content.findLast((entry) => entry.type === "text")
  return part?.type === "text" ? part.text : undefined
}

function reasoning(setup: ReturnType<typeof fixture>) {
  const item = assistant(setup.data.session.message.list(sessionID))
  const part = item?.content.findLast((entry) => entry.type === "reasoning")
  return part?.type === "reasoning" ? part.text : undefined
}

function toolInput(setup: ReturnType<typeof fixture>) {
  const item = assistant(setup.data.session.message.list(sessionID))
  const part = item?.content.findLast((entry) => entry.type === "tool" && entry.id === toolID)
  if (part?.type !== "tool") return undefined
  return part.state.status === "streaming" ? part.state.input : undefined
}

// The flush is deferred to a microtask, so a delta batch is applied once the dispatch batch returns.
const settled = () => new Promise<void>((resolve) => queueMicrotask(() => resolve())).then(() => Promise.resolve())

function seedText(setup: ReturnType<typeof fixture>) {
  setup.publish(stepStarted())
  setup.publish(textStarted())
}

test("holds streamed text deltas until the dispatch batch flushes", async () => {
  const setup = fixture()
  try {
    seedText(setup)
    setup.publish(textDelta("a"), textDelta("b"), textDelta("c"))

    // Deltas accumulate instead of writing the store once per event.
    expect(text(setup)).toBe("")
    await settled()
    expect(text(setup)).toBe("abc")
  } finally {
    setup.dispose()
  }
})

test("coalesced deltas match the unbatched result across batches", async () => {
  const setup = fixture()
  try {
    seedText(setup)
    setup.publish(textDelta("Hel"), textDelta("lo "))
    await settled()
    setup.publish(textDelta("world"))
    await settled()
    expect(text(setup)).toBe("Hello world")
  } finally {
    setup.dispose()
  }
})

test("a full-value text end supersedes deltas pending in the same batch", async () => {
  const setup = fixture()
  try {
    seedText(setup)
    setup.publish(textDelta("Hel"), textDelta("lo"), textEnded("Hello world"))
    await settled()
    expect(text(setup)).toBe("Hello world")
  } finally {
    setup.dispose()
  }
})

test("keeps deltas that arrive after a completed part on the next part", async () => {
  const setup = fixture()
  try {
    seedText(setup)
    setup.publish(textEnded("first"))
    await settled()
    setup.publish(textStarted(1), textDelta("second"))
    await settled()
    const item = assistant(setup.data.session.message.list(sessionID))
    const parts = (item?.content ?? []).flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    expect(parts).toEqual(["first", "second"])
  } finally {
    setup.dispose()
  }
})

test("coalesces reasoning deltas and lets the full value win", async () => {
  const setup = fixture()
  try {
    setup.publish(stepStarted())
    setup.publish(reasoningStarted())
    setup.publish(reasoningDelta("th"), reasoningDelta("ink"))
    expect(reasoning(setup)).toBe("")
    await settled()
    expect(reasoning(setup)).toBe("think")

    setup.publish(reasoningDelta("!"), reasoningEnded("thinking"))
    await settled()
    expect(reasoning(setup)).toBe("thinking")
  } finally {
    setup.dispose()
  }
})

test("coalesces tool input deltas and lets the full value win", async () => {
  const setup = fixture()
  try {
    setup.publish(stepStarted())
    setup.publish(toolInputStarted())
    setup.publish(toolInputDelta('{"pa'), toolInputDelta('th"'))
    expect(toolInput(setup)).toBe("")
    await settled()
    expect(toolInput(setup)).toBe('{"path"')

    setup.publish(toolInputDelta("}}"), toolInputEnded('{"path":"/tmp"}'))
    await settled()
    expect(toolInput(setup)).toBe('{"path":"/tmp"}')
  } finally {
    setup.dispose()
  }
})

test("settles pending fragments onto the part they were streamed for", async () => {
  const setup = fixture()
  try {
    seedText(setup)
    // Both land in one dispatch batch, so the fragments have not been applied yet when the next
    // part starts. They belong to the part they were streamed for, not to the one replacing it.
    setup.publish(textDelta("keep"), textStarted(1))
    await settled()
    const item = assistant(setup.data.session.message.list(sessionID))
    const parts = (item?.content ?? []).flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    expect(parts).toEqual(["keep", ""])
  } finally {
    setup.dispose()
  }
})

test("drops deltas whose message was never loaded", async () => {
  const setup = fixture()
  try {
    setup.publish(textDelta("orphan"))
    await settled()
    expect(setup.data.session.message.list(sessionID)).toEqual([])
  } finally {
    setup.dispose()
  }
})

test("streams independent deltas for two fields in one batch", async () => {
  const setup = fixture()
  try {
    setup.publish(stepStarted())
    setup.publish(textStarted(), reasoningStarted())
    setup.publish(textDelta("answer"), reasoningDelta("thought"))
    await settled()
    expect(text(setup)).toBe("answer")
    expect(reasoning(setup)).toBe("thought")
  } finally {
    setup.dispose()
  }
})
