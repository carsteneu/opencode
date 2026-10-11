import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionMessageInfo } from "../src/promise"

type Listener = Parameters<CreateDataInput["event"]["listen"]>[0]

const sessionID = "ses_window"

const row = (id: string, created: number): SessionMessageInfo => ({ id, type: "user", text: id, time: { created } })

function fixture(
  load: (cursor: string | undefined) => { data: SessionMessageInfo[]; next?: string },
  options: { block?: (cursor: string) => Promise<void> } = {},
) {
  const cursors: (string | null)[] = []
  const listeners = new Set<Listener>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      if (!url.pathname.endsWith("/message")) return Response.json({ data: [], cursor: {} })
      const cursor = url.searchParams.get("cursor") ?? undefined
      cursors.push(url.searchParams.get("cursor"))
      if (cursor !== undefined && options.block) await options.block(cursor)
      const page = load(cursor)
      return Response.json({ data: page.data, cursor: page.next ? { next: page.next } : {} })
    },
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
    cursors,
    emit(details: OpenCodeEvent) {
      listeners.forEach((listener) => listener({ name: details.type, details }))
    },
    // Rows arrive one event at a time, like a session producing messages while it streams.
    stream(count: number, offset = 0) {
      for (let index = 0; index < count; index++) {
        const seq = offset + index
        this.emit({
          id: `evt_syn_${seq}`,
          created: seq,
          type: "session.synthetic",
          durable: { aggregateID: sessionID, seq, version: 1 },
          data: { sessionID, text: `row ${seq}`, description: "row" },
        })
      }
    },
  }
}

// `message.list` returns newest first for the initial read and older pages behind a cursor.
const newestPage = (cursor: string | undefined) =>
  cursor === undefined
    ? { data: [row("msg_new_2", 3), row("msg_new_1", 2), row("msg_new_0", 1)], next: "older" }
    : cursor === "older"
      ? { data: [row("msg_old_1", -1), row("msg_old_0", -2)], next: "oldest" }
      : { data: [], next: undefined }

test("bounds the transcript rows retained for a session", () => {
  const setup = fixture(() => ({ data: [] }))
  try {
    setup.stream(120)
    const ids = setup.data.session.message.list(sessionID).map((message) => message.id)
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe("msg_syn_20")
    expect(ids.at(-1)).toBe("msg_syn_119")
    expect(setup.data.session.message.get(sessionID, "msg_syn_19")).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("retires the history cursor along with the rows it drops", async () => {
  const setup = fixture(newestPage)
  try {
    await setup.data.session.message.sync(sessionID)
    expect(setup.data.session.message.more(sessionID)).toBe(true)

    setup.stream(120)

    expect(setup.data.session.message.list(sessionID)).toHaveLength(100)
    expect(setup.data.session.message.more(sessionID)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("keeps history the reader loaded explicitly", async () => {
  const setup = fixture(newestPage)
  try {
    await setup.data.session.message.sync(sessionID)
    await setup.data.session.message.loadMore(sessionID)
    expect(setup.data.session.message.list(sessionID)).toHaveLength(5)

    setup.stream(120)

    const ids = setup.data.session.message.list(sessionID).map((message) => message.id)
    expect(ids).toHaveLength(125)
    expect(ids[0]).toBe("msg_old_0")
  } finally {
    setup.dispose()
  }
})

test("keeps the history behind a jump to the start", async () => {
  const setup = fixture(newestPage)
  try {
    await setup.data.session.message.sync(sessionID)
    await setup.data.session.message.loadMore(sessionID, { all: true })
    expect(setup.data.session.message.list(sessionID).map((message) => message.id)).toEqual([
      "msg_old_0",
      "msg_old_1",
      "msg_new_0",
      "msg_new_1",
      "msg_new_2",
    ])

    setup.stream(120)

    expect(setup.data.session.message.list(sessionID)).toHaveLength(125)
  } finally {
    setup.dispose()
  }
})

test("holds the window open while a page is in flight", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const setup = fixture(newestPage, { block: () => gate })
  try {
    await setup.data.session.message.sync(sessionID)
    const loading = setup.data.session.message.loadMore(sessionID)

    // The window would trim here, but moving the frontier now would make the page land across a
    // gap, so the retained rows stay until the page is spliced in.
    setup.stream(120)
    expect(setup.data.session.message.list(sessionID)).toHaveLength(123)

    release()
    await loading

    const ids = setup.data.session.message.list(sessionID).map((message) => message.id)
    expect(ids).toHaveLength(125)
    expect(ids[0]).toBe("msg_old_0")
    expect(ids[2]).toBe("msg_new_0")
    expect(ids.at(-1)).toBe("msg_syn_119")
  } finally {
    setup.dispose()
  }
})

test("does not splice in a page a re-read replaced", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reads = 0
  const setup = fixture(
    (cursor) => {
      if (cursor === undefined) {
        reads += 1
        return reads === 1
          ? { data: [row("msg_new_1", 1)], next: "at_new_1" }
          : { data: [row("msg_new_2", 2)], next: "at_new_2" }
      }
      if (cursor === "at_new_1") return { data: [row("msg_old_0", 0)], next: "at_old_0" }
      return { data: [], next: undefined }
    },
    { block: () => gate },
  )
  try {
    await setup.data.session.message.sync(sessionID)
    const loading = setup.data.session.message.loadMore(sessionID)

    // The re-read replaces the transcript and mints a frontier of its own while the page is in
    // flight: that page starts below rows the store no longer holds.
    setup.data.session.evict(sessionID)
    await setup.data.session.message.sync(sessionID)

    release()
    await loading

    expect(setup.data.session.message.list(sessionID).map((message) => message.id)).toEqual(["msg_new_2"])
    expect(setup.data.session.message.loading(sessionID)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("restores the window after a session is evicted", async () => {
  const setup = fixture(newestPage)
  try {
    await setup.data.session.message.sync(sessionID)
    await setup.data.session.message.loadMore(sessionID)
    setup.data.session.evict(sessionID)

    setup.stream(120)

    const ids = setup.data.session.message.list(sessionID).map((message) => message.id)
    expect(ids).toHaveLength(100)
    expect(ids.at(-1)).toBe("msg_syn_119")
  } finally {
    setup.dispose()
  }
})
