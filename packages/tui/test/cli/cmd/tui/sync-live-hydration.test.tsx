/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

const user = {
  id: "msg_user",
  sessionID,
  role: "user" as const,
  time: { created: 0 },
  summary: {
    title: "kept title",
    body: "kept body",
    diffs: [{ file: "src/index.ts", patch: "PATCH_SENTINEL", additions: 1, deletions: 0, status: "modified" as const }],
  },
  agent: "build",
  model: { providerID: "test", modelID: "model" },
}

test("message hydration and live events retain diff metadata without patch text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const headers: Array<string | null> = []
  const { app, emit, sync } = await mount((url, request) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      headers.push(request.headers.get("x-opencode-message-patches"))
      if (url.searchParams.has("before")) return json([])
      return json([{ info: user, parts: [] }])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(headers).toEqual(["omit"])
    const hydrated = sync.data.message[sessionID]?.[0]
    expect(hydrated).toMatchObject({ id: user.id, summary: { title: "kept title", body: "kept body" } })
    if (hydrated?.role !== "user") throw new Error("Expected user message")
    expect(hydrated.summary?.diffs).toEqual([{ file: "src/index.ts", additions: 1, deletions: 0, status: "modified" }])

    emit(
      global({
        id: "evt_user",
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            ...user,
            summary: {
              ...user.summary,
              title: "live title",
              diffs: [{ ...user.summary.diffs[0], patch: "LIVE_PATCH_SENTINEL" }],
            },
          },
        },
      }),
    )
    await wait(
      () =>
        sync.data.message[sessionID]?.[0]?.role === "user" &&
        sync.data.message[sessionID][0].summary?.title === "live title",
    )
    const updated = sync.data.message[sessionID]?.[0]
    if (updated?.role !== "user") throw new Error("Expected user message")
    expect(updated.summary?.title).toBe("live title")
    expect(updated.summary?.diffs?.[0]?.patch).toBeUndefined()

    await sync.session.loadOlder(sessionID)
    expect(headers).toEqual(["omit", "omit"])
  } finally {
    app.renderer.destroy()
  }
})

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function textPartUpdated(text: string, id = "evt_part") {
  return global({
    id,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: 1,
      part: { id: partID, sessionID, messageID, type: "text", text },
    },
  })
}

function textDelta(delta: string, id = "evt_delta") {
  return global({
    id,
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field: "text", delta },
  })
}

function startSDKPublication(emit: (event: GlobalEvent) => void) {
  emit(global({ id: "evt_boundary", type: "server.connected", properties: {} }))
}

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 2, completed: 3 } },
    { ...assistant, id: "msg_c", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual([
      "msg_z",
      "msg_c",
      "msg_b",
      "msg_m",
      "msg_a",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
      }),
    )
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "hydrated" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test("batched deltas expose append provenance until a full snapshot arrives", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "Hello " },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "world" },
      }),
    )
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "Hello world",
    )

    expect(sync.partDelta(messageID, partID, "text")).toMatchObject({ fromLength: 6, toLength: 11 })

    emit(
      global({
        id: "evt_snapshot",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "replacement" },
        },
      }),
    )
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "replacement",
    )
    expect(sync.partDelta(messageID, partID, "text")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("an 80,000-delta synchronous burst commits once with exact append provenance", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(() => undefined, tmp.path)
  const deltas = Array.from({ length: 80_000 }, (_, index) => `${index.toString(36).padStart(4, "0")}|`)

  try {
    emit(textPartUpdated("base"))
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    startSDKPublication(emit)
    deltas.forEach((delta, index) => {
      emit(textDelta(delta, `evt_delta_${index}`))
      if ((index + 1) % 10_000 === 0) expect(sync.data.part[messageID]?.[0]).toMatchObject({ text: "base" })
    })
    const expected = `base${deltas.join("")}`
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === expected,
      10_000,
    )

    expect(sync.data.part[messageID][0]).toMatchObject({ text: expected })
    expect(sync.partDelta(messageID, partID, "text")).toEqual({
      fromLength: 4,
      toLength: expected.length,
      revision: 1,
    })
  } finally {
    app.renderer.destroy()
  }
})

test("reasoning deltas use the same single-publication accumulator", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_reasoning_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "reasoning", text: "Plan: ", time: { start: 1 } },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "reasoning")

    startSDKPublication(emit)
    emit(textDelta("inspect", "evt_reasoning_delta_1"))
    emit(textDelta(", ", "evt_reasoning_delta_2"))
    emit(textDelta("verify", "evt_reasoning_delta_3"))
    await wait(
      () =>
        sync.data.part[messageID]?.[0]?.type === "reasoning" &&
        sync.data.part[messageID][0].text === "Plan: inspect, verify",
    )

    expect(sync.partDelta(messageID, partID, "text")).toEqual({
      fromLength: 6,
      toLength: 21,
      revision: 1,
    })
  } finally {
    app.renderer.destroy()
  }
})

test("a full snapshot cancels a pending delta without a late append", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(textPartUpdated("base"))
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")
    emit(textDelta(" applied"))
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "base applied",
    )
    expect(sync.partDelta(messageID, partID, "text")).toBeDefined()

    startSDKPublication(emit)
    emit(textDelta(" late", "evt_delta_late"))
    emit(textPartUpdated("replacement", "evt_snapshot"))
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "replacement",
    )
    await Bun.sleep(0)

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "replacement" })
    expect(sync.partDelta(messageID, partID, "text")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("part removal cancels pending and applied deltas", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(textPartUpdated("base"))
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")
    emit(textDelta(" applied"))
    await wait(
      () => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "base applied",
    )
    expect(sync.partDelta(messageID, partID, "text")).toBeDefined()

    startSDKPublication(emit)
    emit(textDelta(" late", "evt_delta_late"))
    emit(
      global({
        id: "evt_part_removed",
        type: "message.part.removed",
        properties: { sessionID, messageID, partID },
      }),
    )
    await wait(() => sync.data.part[messageID]?.length === 0)
    await Bun.sleep(0)

    expect(sync.data.part[messageID]).toEqual([])
    expect(sync.partDelta(messageID, partID, "text")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("instance disposal invalidates a pending delta generation", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const mounted = await mount(() => undefined, tmp.path)

  try {
    mounted.emit(textPartUpdated("base"))
    await wait(() => mounted.sync.data.part[messageID]?.[0]?.type === "text")
    mounted.emit(textDelta(" applied"))
    await wait(
      () =>
        mounted.sync.data.part[messageID]?.[0]?.type === "text" &&
        mounted.sync.data.part[messageID][0].text === "base applied",
    )
    expect(mounted.sync.partDelta(messageID, partID, "text")).toBeDefined()
    const bootstrapCalls = mounted.session.length

    startSDKPublication(mounted.emit)
    mounted.emit(textDelta(" late", "evt_delta_late"))
    mounted.emit(
      global({
        id: "evt_disposed",
        type: "server.instance.disposed",
        properties: { directory: session.directory },
      }),
    )
    await wait(() => mounted.session.length > bootstrapCalls)
    await Bun.sleep(0)

    expect(mounted.sync.data.part[messageID][0]).toMatchObject({ text: "base applied" })
    expect(mounted.sync.partDelta(messageID, partID, "text")).toBeUndefined()
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("deltas published during hydration survive a stale response", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(textPartUpdated("base"))
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    startSDKPublication(emit)
    emit(textDelta(" during", "evt_delta_1"))
    emit(textDelta(" hydration", "evt_delta_2"))
    await wait(
      () =>
        sync.data.part[messageID]?.[0]?.type === "text" &&
        sync.data.part[messageID][0].text === "base during hydration",
    )

    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "base during hydration" })
  } finally {
    app.renderer.destroy()
  }
})

test("live messages merged during hydration retain the 100 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("hydration window trimming clears delta provenance for removed messages", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  const oldestMessageID = "msg_000"
  const oldestPartID = "prt_msg_000"

  try {
    emit(
      global({
        id: "evt_oldest",
        type: "message.updated",
        properties: {
          sessionID,
          info: { ...assistant, id: oldestMessageID, time: { created: 1, completed: 2 } },
        },
      }),
    )
    emit(
      global({
        id: "evt_oldest_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: oldestPartID, sessionID, messageID: oldestMessageID, type: "text", text: "base" },
        },
      }),
    )
    await wait(() => sync.data.part[oldestMessageID]?.[0]?.type === "text")
    emit(
      global({
        id: "evt_oldest_delta",
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID: oldestMessageID,
          partID: oldestPartID,
          field: "text",
          delta: " appended",
        },
      }),
    )
    await wait(
      () =>
        sync.data.part[oldestMessageID]?.[0]?.type === "text" &&
        sync.data.part[oldestMessageID][0].text === "base appended",
    )
    expect(sync.partDelta(oldestMessageID, oldestPartID, "text")).toBeDefined()

    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_live",
        type: "message.updated",
        properties: {
          sessionID,
          info: { ...assistant, id: "msg_100", time: { created: 101, completed: 102 } },
        },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === "msg_100") ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id, time: { created: index + 1, completed: index + 2 } },
            parts: [
              {
                id: `prt_${id}`,
                sessionID,
                messageID: id,
                type: "text",
                text: id === oldestMessageID ? "base appended" : id,
              },
            ],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].some((message) => message.id === oldestMessageID)).toBe(false)
    expect(sync.data.part[oldestMessageID]).toBeUndefined()
    expect(sync.partDelta(oldestMessageID, oldestPartID, "text")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("100-message eviction clears part storage and delta provenance", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount(undefined, tmp.path)
  const oldestMessageID = "msg_000"
  const oldestPartID = "prt_msg_000"

  try {
    for (let index = 0; index < 100; index++) {
      const id = `msg_${String(index).padStart(3, "0")}`
      emit(
        global({
          id: `evt_${id}`,
          type: "message.updated",
          properties: {
            sessionID,
            info: { ...assistant, id, time: { created: index + 1, completed: index + 2 } },
          },
        }),
      )
    }
    await wait(() => sync.data.message[sessionID]?.length === 100)
    emit(
      global({
        id: "evt_oldest_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: {
            id: oldestPartID,
            sessionID,
            messageID: oldestMessageID,
            type: "text",
            text: "base",
          },
        },
      }),
    )
    await wait(() => sync.data.part[oldestMessageID]?.[0]?.type === "text")
    emit(
      global({
        id: "evt_oldest_delta",
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID: oldestMessageID,
          partID: oldestPartID,
          field: "text",
          delta: " appended",
        },
      }),
    )
    await wait(
      () =>
        sync.data.part[oldestMessageID]?.[0]?.type === "text" &&
        sync.data.part[oldestMessageID][0].text === "base appended",
    )
    expect(sync.partDelta(oldestMessageID, oldestPartID, "text")).toBeDefined()

    emit(
      global({
        id: "evt_msg_100",
        type: "message.updated",
        properties: {
          sessionID,
          info: { ...assistant, id: "msg_100", time: { created: 101, completed: 102 } },
        },
      }),
    )
    await wait(
      () =>
        sync.data.message[sessionID]?.length === 100 &&
        !sync.data.message[sessionID].some((message) => message.id === oldestMessageID),
    )

    expect(sync.data.part[oldestMessageID]).toBeUndefined()
    expect(sync.partDelta(oldestMessageID, oldestPartID, "text")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
