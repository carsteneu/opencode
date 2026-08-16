import { describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventMaintenance } from "@opencode-ai/core/event/maintenance"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

type FixtureEvent = {
  readonly id: string
  readonly seq: number
  readonly type: string
  readonly data: string
}

type SourceEvent = FixtureEvent & {
  readonly aggregateID: string
}

const sessionUpdated = (sessionID: string, title: string) =>
  JSON.stringify({ sessionID, info: { id: sessionID, title } })

const messageUpdated = (sessionID: string, messageID: string, text: string) =>
  JSON.stringify({ sessionID, info: { id: messageID, sessionID, text } })

const partUpdated = (sessionID: string, partID: string, text: string) =>
  JSON.stringify({ sessionID, part: { id: partID, sessionID, messageID: "msg_fixture", type: "text", text } })

const insertAggregate = (
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly head: number
    readonly ownerID?: string
    readonly events: ReadonlyArray<FixtureEvent>
  },
) =>
  Effect.gen(function* () {
    yield* db
      .run(
        sql`
        INSERT INTO event_sequence (aggregate_id, seq, owner_id)
        VALUES (${input.aggregateID}, ${input.head}, ${input.ownerID ?? null})
      `,
      )
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      input.events,
      (event) =>
        db
          .run(
            sql`
            INSERT INTO event (id, aggregate_id, seq, type, data)
            VALUES (${event.id}, ${input.aggregateID}, ${event.seq}, ${event.type}, ${event.data})
          `,
          )
          .pipe(Effect.orDie),
      { discard: true },
    )
  })

const source = (db: Database.Interface["db"]) =>
  Effect.all({
    events: db
      .all<SourceEvent>(
        sql`
        SELECT id, aggregate_id AS aggregateID, seq, type, data
        FROM event
        ORDER BY aggregate_id, seq
      `,
      )
      .pipe(Effect.orDie),
    sequences: db
      .all<{ readonly aggregateID: string; readonly seq: number; readonly ownerID: string | null }>(
        sql`
        SELECT aggregate_id AS aggregateID, seq, owner_id AS ownerID
        FROM event_sequence
        ORDER BY aggregate_id
      `,
      )
      .pipe(Effect.orDie),
  })

describe("EventMaintenance.analyze", () => {
  it.effect("reports deterministic UTF-8 bytes and only potential repeated v1 snapshots", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = "ses_local"
      const firstSession = sessionUpdated(sessionID, "first")
      const secondSession = sessionUpdated(sessionID, "second")
      const latestSession = sessionUpdated(sessionID, "latest")
      const firstMessage = messageUpdated(sessionID, "msg_one", "first")
      const latestMessage = messageUpdated(sessionID, "msg_one", "latest")
      const otherMessage = messageUpdated(sessionID, "msg_two", "only")
      const firstPart = partUpdated(sessionID, "prt_one", "Grüße 👋")
      const latestPart = partUpdated(sessionID, "prt_one", "Grüße 👋 – latest")
      const futurePart = partUpdated(sessionID, "prt_one", "future")
      const created = JSON.stringify({ sessionID, info: { id: sessionID } })
      const removed = JSON.stringify({ sessionID, messageID: "msg_two" })
      const events = [
        { id: "evt_000", seq: 0, type: "session.created.1", data: created },
        { id: "evt_001", seq: 1, type: "session.updated.1", data: firstSession },
        { id: "evt_002", seq: 2, type: "session.updated.1", data: secondSession },
        { id: "evt_003", seq: 3, type: "session.updated.1", data: latestSession },
        { id: "evt_004", seq: 4, type: "message.updated.1", data: firstMessage },
        { id: "evt_005", seq: 5, type: "message.updated.1", data: latestMessage },
        { id: "evt_006", seq: 6, type: "message.updated.1", data: otherMessage },
        { id: "evt_007", seq: 7, type: "message.part.updated.1", data: firstPart },
        { id: "evt_008", seq: 8, type: "message.part.updated.1", data: latestPart },
        { id: "evt_009", seq: 9, type: "message.part.updated.2", data: futurePart },
        { id: "evt_010", seq: 10, type: "message.removed.1", data: removed },
      ] satisfies FixtureEvent[]
      yield* insertAggregate(db, { aggregateID: sessionID, head: 10, events })
      const before = yield* source(db)

      const first = yield* EventMaintenance.analyze(db)
      const second = yield* EventMaintenance.analyze(db)

      expect(second).toEqual(first)
      expect(first).toEqual({
        dryRun: true,
        applySupported: false,
        total: {
          events: events.length,
          payloadBytes: events.reduce((sum, event) => sum + Buffer.byteLength(event.data), 0),
          aggregates: 1,
        },
        byType: [
          { type: "message.part.updated.1", events: 2, payloadBytes: Buffer.byteLength(firstPart + latestPart) },
          { type: "message.part.updated.2", events: 1, payloadBytes: Buffer.byteLength(futurePart) },
          { type: "message.removed.1", events: 1, payloadBytes: Buffer.byteLength(removed) },
          {
            type: "message.updated.1",
            events: 3,
            payloadBytes: Buffer.byteLength(firstMessage + latestMessage + otherMessage),
          },
          { type: "session.created.1", events: 1, payloadBytes: Buffer.byteLength(created) },
          {
            type: "session.updated.1",
            events: 3,
            payloadBytes: Buffer.byteLength(firstSession + secondSession + latestSession),
          },
        ],
        repeatedSnapshots: {
          classification: "potential",
          events: 4,
          payloadBytes: Buffer.byteLength(firstSession + secondSession + firstMessage + firstPart),
          byType: [
            { type: "message.part.updated.1", events: 1, payloadBytes: Buffer.byteLength(firstPart) },
            { type: "message.updated.1", events: 1, payloadBytes: Buffer.byteLength(firstMessage) },
            {
              type: "session.updated.1",
              events: 2,
              payloadBytes: Buffer.byteLength(firstSession + secondSession),
            },
          ],
        },
        blockers: {
          checkpointProtocolUnavailable: true,
          ownedAggregates: 0,
          workspaceAggregates: 0,
          sequenceGaps: 0,
          sequenceHeadMismatches: 0,
          invalidPayloads: 0,
          aggregatePayloadMismatches: 0,
          unsupportedSnapshotVersions: 1,
        },
      })
      expect(yield* source(db)).toEqual(before)
    }),
  )

  it.effect("reports aggregate, sequence, payload, owner, workspace, and version blockers without writes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .run(
          sql`
          INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES ('project_fixture', '/project', 0, 0, '[]')
        `,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`
          INSERT INTO session (
            id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'ses_workspace', 'project_fixture', 'wrk_fixture', 'fixture', '/project', 'Fixture', 'test', 0, 0
          )
        `,
        )
        .pipe(Effect.orDie)

      yield* insertAggregate(db, {
        aggregateID: "ses_owner",
        head: 0,
        ownerID: "wrk_owner",
        events: [{ id: "evt_owner", seq: 0, type: "session.updated.1", data: sessionUpdated("ses_owner", "x") }],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_workspace",
        head: 0,
        events: [
          { id: "evt_workspace", seq: 0, type: "session.updated.1", data: sessionUpdated("ses_workspace", "x") },
        ],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_gap",
        head: 2,
        events: [
          { id: "evt_gap_0", seq: 0, type: "session.created.1", data: "{}" },
          { id: "evt_gap_2", seq: 2, type: "message.removed.1", data: "{}" },
        ],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_head",
        head: 3,
        events: [{ id: "evt_head", seq: 0, type: "session.created.1", data: "{}" }],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_invalid",
        head: 1,
        events: [
          { id: "evt_invalid_json", seq: 0, type: "session.updated.1", data: "{not-json" },
          {
            id: "evt_invalid_shape",
            seq: 1,
            type: "message.updated.1",
            data: JSON.stringify({ sessionID: "ses_invalid", info: { sessionID: "ses_invalid" } }),
          },
        ],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_mismatch",
        head: 0,
        events: [
          {
            id: "evt_mismatch",
            seq: 0,
            type: "session.updated.1",
            data: sessionUpdated("ses_other", "wrong aggregate"),
          },
        ],
      })
      yield* insertAggregate(db, {
        aggregateID: "ses_future",
        head: 2,
        events: [
          { id: "evt_future_session", seq: 0, type: "session.updated.2", data: "{}" },
          { id: "evt_future_message", seq: 1, type: "message.updated.99", data: "{}" },
          { id: "evt_unversioned_part", seq: 2, type: "message.part.updated", data: "{}" },
        ],
      })
      const before = yield* source(db)

      const report = yield* EventMaintenance.analyze(db)

      expect(report.total.aggregates).toBe(7)
      expect(report.repeatedSnapshots).toEqual({
        classification: "potential",
        events: 0,
        payloadBytes: 0,
        byType: [],
      })
      expect(report.blockers).toEqual({
        checkpointProtocolUnavailable: true,
        ownedAggregates: 1,
        workspaceAggregates: 1,
        sequenceGaps: 1,
        sequenceHeadMismatches: 1,
        invalidPayloads: 2,
        aggregatePayloadMismatches: 1,
        unsupportedSnapshotVersions: 3,
      })
      expect(yield* source(db)).toEqual(before)
    }),
  )

  test("keeps one read snapshot while a WAL writer appends after the first select", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "event-maintenance.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = "ses_concurrent"
        const first = sessionUpdated(sessionID, "before snapshot")
        const appended = sessionUpdated(sessionID, "after snapshot")
        yield* insertAggregate(db, {
          aggregateID: sessionID,
          head: 0,
          events: [{ id: "evt_before_snapshot", seq: 0, type: "session.updated.1", data: first }],
        })

        const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new sqlite.Database(filename)),
          (connection) => Effect.sync(() => connection.close()),
        )
        writer.exec("PRAGMA foreign_keys = ON")
        writer.exec("PRAGMA busy_timeout = 5000")
        const insertEvent = writer.prepare(
          "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
        )
        const updateHead = writer.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?")
        const append = writer.transaction(() => {
          insertEvent.run("evt_after_snapshot", sessionID, 1, "session.updated.1", appended)
          updateHead.run(1, sessionID)
        })
        let didAppend = false
        const intercepted = new Proxy(db, {
          get(target, property) {
            if (property === "get") {
              return (query: Parameters<typeof target.get>[0]) => {
                const result = target.get(query)
                if (didAppend) return result
                return result.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      append()
                      didAppend = true
                    }),
                  ),
                )
              }
            }
            const value: unknown = Reflect.get(target, property, target)
            if (typeof value === "function") return value.bind(target)
            return value
          },
        })

        const report = yield* EventMaintenance.analyze(intercepted)

        expect(didAppend).toBe(true)
        expect(report).toEqual({
          dryRun: true,
          applySupported: false,
          total: { events: 1, payloadBytes: Buffer.byteLength(first), aggregates: 1 },
          byType: [{ type: "session.updated.1", events: 1, payloadBytes: Buffer.byteLength(first) }],
          repeatedSnapshots: {
            classification: "potential",
            events: 0,
            payloadBytes: 0,
            byType: [],
          },
          blockers: {
            checkpointProtocolUnavailable: true,
            ownedAggregates: 0,
            workspaceAggregates: 0,
            sequenceGaps: 0,
            sequenceHeadMismatches: 0,
            invalidPayloads: 0,
            aggregatePayloadMismatches: 0,
            unsupportedSnapshotVersions: 0,
          },
        })
        expect(
          writer
            .query("SELECT id, aggregate_id AS aggregateID, seq, type, data FROM event WHERE id = ?")
            .get("evt_after_snapshot"),
        ).toEqual({
          id: "evt_after_snapshot",
          aggregateID: sessionID,
          seq: 1,
          type: "session.updated.1",
          data: appended,
        })
        expect(writer.query("SELECT seq FROM event_sequence WHERE aggregate_id = ?").get(sessionID)).toEqual({ seq: 1 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })
})
