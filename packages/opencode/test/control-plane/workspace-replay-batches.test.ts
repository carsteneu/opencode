import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { MessageID } from "@opencode-ai/core/v1/session"
import { SessionID } from "@/session/schema"
import { WARP_REPLAY_BYTES, WARP_REPLAY_EVENTS, replayBatches } from "../../src/control-plane/workspace"

type ReplayBody = {
  directory: string
  events: EventV2.SerializedEvent[]
  messageDiffs?: MessageDiff.Snapshot
}

const sessionID = SessionID.make("ses_warp_batch")

function replayEvent(seq: number, data: Record<string, unknown> = {}): EventV2.SerializedEvent {
  return {
    id: EventV2.ID.make(`evt_warp_batch_${seq}`),
    aggregateID: sessionID,
    seq,
    type: "test.warp.1",
    data,
  }
}

function parse(body: string) {
  return JSON.parse(body) as ReplayBody
}

function bytes(body: string) {
  return Buffer.byteLength(body, "utf8")
}

describe("workspace replay batches", () => {
  test("splits 257 small events at the count limit without reordering", () => {
    const events = Array.from({ length: WARP_REPLAY_EVENTS + 1 }, (_, seq) => replayEvent(seq))
    const bodies = [...replayBatches({ directory: "/target", events })]
    const payloads = bodies.map(parse)

    expect(payloads.map((payload) => payload.events.length)).toEqual([WARP_REPLAY_EVENTS, 1])
    expect(payloads.flatMap((payload) => payload.events.map((event) => event.seq))).toEqual(
      events.map((event) => event.seq),
    )
    expect(bodies.every((body) => bytes(body) <= WARP_REPLAY_BYTES)).toBe(true)
  })

  test("uses exact UTF-8 request bytes at the boundary and preserves order after a byte split", () => {
    const events = [replayEvent(0), replayEvent(1, { text: "" })]
    const base = [...replayBatches({ directory: "/target", events })][0]!
    events[1] = replayEvent(1, { text: "a".repeat(WARP_REPLAY_BYTES - bytes(base)) })

    const exact = [...replayBatches({ directory: "/target", events })]
    expect(exact).toHaveLength(1)
    expect(bytes(exact[0]!)).toBe(WARP_REPLAY_BYTES)

    events[1] = replayEvent(1, { text: `${events[1]!.data.text}é` })
    const split = [...replayBatches({ directory: "/target", events })]
    expect(split.map((body) => parse(body).events.map((event) => event.seq))).toEqual([[0], [1]])
    expect(split.every((body) => bytes(body) <= WARP_REPLAY_BYTES)).toBe(true)
  })

  test("allows one oversized event to make progress and continues with the next event", () => {
    const events = [replayEvent(0, { text: "x".repeat(WARP_REPLAY_BYTES) }), replayEvent(1)]
    const bodies = [...replayBatches({ directory: "/target", events })]
    const payloads = bodies.map(parse)

    expect(payloads.map((payload) => payload.events.map((event) => event.seq))).toEqual([[0], [1]])
    expect(bytes(bodies[0]!)).toBeGreaterThan(WARP_REPLAY_BYTES)
    expect(bytes(bodies[1]!)).toBeLessThanOrEqual(WARP_REPLAY_BYTES)
  })

  test("allows one oversized portable diff to make progress and continues with targeted rows", () => {
    const rows: MessageDiff.Entry[] = [
      {
        messageID: MessageID.ascending("msg_warp_oversized"),
        revision: "oversized",
        diffs: [
          {
            patch: "x".repeat(WARP_REPLAY_BYTES + 1024),
            additions: 1,
            deletions: 0,
            status: "modified",
          },
        ],
      },
      {
        messageID: MessageID.ascending("msg_warp_after_oversized"),
        revision: "after-oversized",
        diffs: [],
      },
    ]
    const bodies = [
      ...replayBatches({
        directory: "/target",
        events: [replayEvent(0)],
        messageDiffs: { sessionID, rows },
      }),
    ]
    const payloads = bodies.map(parse)

    expect(payloads).toHaveLength(3)
    expect(payloads[0]?.messageDiffs).toEqual({ sessionID, rows: [] })
    expect(payloads[1]?.messageDiffs).toEqual({
      sessionID,
      messageIDs: [rows[0]!.messageID],
      rows: [rows[0]],
    })
    expect(bytes(bodies[1]!)).toBeGreaterThan(WARP_REPLAY_BYTES)
    expect(payloads[2]?.messageDiffs).toEqual({
      sessionID,
      messageIDs: [rows[1]!.messageID],
      rows: [rows[1]],
    })
    expect(bytes(bodies[2]!)).toBeLessThanOrEqual(WARP_REPLAY_BYTES)
  })

  test("serializes only the current event batch and at most one lookahead", () => {
    const reads = new Map<number, number>()
    const events = Array.from({ length: WARP_REPLAY_EVENTS + 20 }, (_, seq) => {
      const data = {}
      Object.defineProperty(data, "seq", {
        enumerable: true,
        get() {
          reads.set(seq, (reads.get(seq) ?? 0) + 1)
          return seq
        },
      })
      return replayEvent(seq, data)
    })
    const batches = replayBatches({ directory: "/target", events })
    const first = batches.next()

    expect(first.done).toBe(false)
    expect(parse(first.value!).events).toHaveLength(WARP_REPLAY_EVENTS)
    expect(Array.from({ length: WARP_REPLAY_EVENTS }, (_, seq) => reads.get(seq))).toEqual(
      Array.from({ length: WARP_REPLAY_EVENTS }, () => 1),
    )
    expect(reads.get(WARP_REPLAY_EVENTS + 1)).toBeUndefined()
  })

  test("sends authoritative portable diffs in bounded chunks after all original events", () => {
    const events = Array.from({ length: WARP_REPLAY_EVENTS + 1 }, (_, seq) =>
      replayEvent(seq, seq === 17 ? {} : { padding: "x".repeat(200) }),
    )
    const rows: MessageDiff.Entry[] = Array.from({ length: 3 }, (_, index) => ({
      messageID: MessageID.ascending(`msg_warp_diff_${index}`),
      revision: `revision-${index}`,
      diffs: [
        {
          file: `file-${index}.ts`,
          patch: "x".repeat(Math.floor(WARP_REPLAY_BYTES * 0.55)),
          additions: 1,
          deletions: 0,
          status: "modified",
        },
      ],
    }))
    const bodies = [
      ...replayBatches({
        directory: "/target",
        events,
        messageDiffs: { sessionID, rows },
      }),
    ]
    const payloads = bodies.map(parse)

    expect(payloads).toHaveLength(4)
    expect(payloads.slice(0, 2).flatMap((payload) => payload.events.map((event) => event.seq))).toEqual(
      events.map((event) => event.seq),
    )
    expect(payloads[0]?.messageDiffs).toBeUndefined()
    expect(payloads[1]?.messageDiffs).toEqual({ sessionID, rows: [rows[0]] })
    expect(payloads.slice(2).map((payload) => payload.messageDiffs?.messageIDs)).toEqual([
      [rows[1]!.messageID],
      [rows[2]!.messageID],
    ])

    const anchor = events.reduce((smallest, event) =>
      bytes(JSON.stringify(event)) < bytes(JSON.stringify(smallest)) ? event : smallest,
    )
    expect(payloads.slice(2).map((payload) => payload.events)).toEqual([[anchor], [anchor]])
    expect(bodies.every((body) => bytes(body) <= WARP_REPLAY_BYTES)).toBe(true)

    const applied = new Map<string, MessageDiff.Entry>([
      [
        MessageID.ascending("msg_warp_stale"),
        { messageID: MessageID.ascending("msg_warp_stale"), revision: "stale", diffs: [] },
      ],
    ])
    payloads.forEach((payload) => {
      if (!payload.messageDiffs) return
      if (!payload.messageDiffs.messageIDs) applied.clear()
      payload.messageDiffs.messageIDs?.forEach((messageID) => applied.delete(messageID))
      payload.messageDiffs.rows.forEach((row) => applied.set(row.messageID, row))
    })
    expect([...applied.values()]).toEqual(rows)
  })

  test("keeps the legacy replay payload shape for an empty portable snapshot", () => {
    const events = Array.from({ length: WARP_REPLAY_EVENTS + 1 }, (_, seq) => replayEvent(seq))
    const payloads = [
      ...replayBatches({
        directory: "/legacy-target",
        events,
        messageDiffs: { sessionID, rows: [] },
      }),
    ].map(parse)

    expect(payloads).toHaveLength(2)
    expect(payloads[0]?.messageDiffs).toBeUndefined()
    expect(payloads[1]).toEqual({
      directory: "/legacy-target",
      events: [events.at(-1)!],
      messageDiffs: { sessionID, rows: [] },
    })
  })
})
