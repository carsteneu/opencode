export * as EventMaintenance from "./maintenance"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

type Count = {
  readonly events: number
  readonly payloadBytes: number
}

type TypeCount = Count & {
  readonly type: string
}

export type Report = {
  readonly dryRun: true
  readonly applySupported: false
  readonly total: Count & { readonly aggregates: number }
  readonly byType: ReadonlyArray<TypeCount>
  readonly repeatedSnapshots: Count & {
    /** Repetition is only a size estimate, not proof that an event can be deleted safely. */
    readonly classification: "potential"
    readonly byType: ReadonlyArray<TypeCount>
  }
  readonly blockers: {
    /** Apply remains disabled until sync peers negotiate a versioned aggregate checkpoint protocol. */
    readonly checkpointProtocolUnavailable: true
    /** Aggregates whose sequence owner is set. */
    readonly ownedAggregates: number
    /** Aggregates projected into a workspace. */
    readonly workspaceAggregates: number
    /** Aggregates whose stored event sequences are not contiguous from zero. */
    readonly sequenceGaps: number
    /** Aggregates whose sequence head differs from their latest event. */
    readonly sequenceHeadMismatches: number
    /** Supported snapshot rows without the JSON shape required for analysis. */
    readonly invalidPayloads: number
    /** Supported snapshot rows whose payload belongs to another aggregate. */
    readonly aggregatePayloadMismatches: number
    /** Snapshot-family rows whose stored version is not the supported v1 form. */
    readonly unsupportedSnapshotVersions: number
  }
}

type TotalRow = {
  readonly events: number
  readonly payloadBytes: number
  readonly aggregates: number
}

type BlockerRow = Omit<Report["blockers"], "checkpointProtocolUnavailable">

const shapedSnapshots = sql`
  SELECT
    id,
    aggregate_id,
    seq,
    type,
    length(CAST(data AS BLOB)) AS payload_bytes,
    json_valid(data) AS valid_json,
    CASE WHEN json_valid(data) = 1 THEN json_type(data, '$.sessionID') END AS payload_session_type,
    CASE WHEN json_valid(data) = 1 THEN json_extract(data, '$.sessionID') END AS payload_session_id,
    CASE
      WHEN json_valid(data) = 1 THEN
        CASE
          WHEN type IN ('session.updated.1', 'message.updated.1') THEN json_type(data, '$.info')
          WHEN type = 'message.part.updated.1' THEN json_type(data, '$.part')
        END
    END AS container_type,
    CASE
      WHEN json_valid(data) = 1 THEN
        CASE
          WHEN type IN ('session.updated.1', 'message.updated.1') THEN json_type(data, '$.info.id')
          WHEN type = 'message.part.updated.1' THEN json_type(data, '$.part.id')
        END
    END AS entity_type,
    CASE
      WHEN json_valid(data) = 1 THEN
        CASE
          WHEN type IN ('session.updated.1', 'message.updated.1') THEN json_extract(data, '$.info.id')
          WHEN type = 'message.part.updated.1' THEN json_extract(data, '$.part.id')
        END
    END AS entity_id,
    CASE
      WHEN json_valid(data) = 1 THEN
        CASE
          WHEN type = 'session.updated.1' THEN json_type(data, '$.info.id')
          WHEN type = 'message.updated.1' THEN json_type(data, '$.info.sessionID')
          WHEN type = 'message.part.updated.1' THEN json_type(data, '$.part.sessionID')
        END
    END AS nested_session_type,
    CASE
      WHEN json_valid(data) = 1 THEN
        CASE
          WHEN type = 'session.updated.1' THEN json_extract(data, '$.info.id')
          WHEN type = 'message.updated.1' THEN json_extract(data, '$.info.sessionID')
          WHEN type = 'message.part.updated.1' THEN json_extract(data, '$.part.sessionID')
        END
    END AS nested_session_id
  FROM event
  WHERE type IN ('session.updated.1', 'message.updated.1', 'message.part.updated.1')
`

export const analyze = Effect.fn("EventMaintenance.analyze")(function* (db: Database.Interface["db"]) {
  return yield* db.transaction(() =>
    Effect.gen(function* () {
      const total = yield* db
        .get<TotalRow>(
          sql`
      SELECT
        COUNT(*) AS events,
        COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS payloadBytes,
        COUNT(DISTINCT aggregate_id) AS aggregates
      FROM event
    `,
        )
        .pipe(Effect.orDie)
      const byType = yield* db
        .all<TypeCount>(
          sql`
      SELECT
        type,
        COUNT(*) AS events,
        COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS payloadBytes
      FROM event
      GROUP BY type
      ORDER BY type
    `,
        )
        .pipe(Effect.orDie)
      const repeatedByType = yield* db
        .all<TypeCount>(
          sql`
      WITH shaped AS (${shapedSnapshots}),
      ranked AS (
        SELECT
          type,
          payload_bytes,
          ROW_NUMBER() OVER (
            PARTITION BY aggregate_id, type, entity_id
            ORDER BY seq DESC
          ) AS position
        FROM shaped
        WHERE
          valid_json = 1
          AND container_type = 'object'
          AND payload_session_type = 'text'
          AND entity_type = 'text'
          AND nested_session_type = 'text'
          AND payload_session_id = aggregate_id
          AND nested_session_id = aggregate_id
      )
      SELECT
        type,
        COUNT(*) AS events,
        COALESCE(SUM(payload_bytes), 0) AS payloadBytes
      FROM ranked
      WHERE position > 1
      GROUP BY type
      ORDER BY type
    `,
        )
        .pipe(Effect.orDie)
      const blockers = yield* db
        .get<BlockerRow>(
          sql`
      WITH shaped AS (${shapedSnapshots}),
      event_heads AS (
        SELECT aggregate_id, MAX(seq) AS seq
        FROM event
        GROUP BY aggregate_id
      ),
      head_mismatches AS (
        SELECT event_sequence.aggregate_id
        FROM event_sequence
        LEFT JOIN event_heads ON event_heads.aggregate_id = event_sequence.aggregate_id
        WHERE event_heads.aggregate_id IS NULL OR event_sequence.seq <> event_heads.seq
        UNION ALL
        SELECT event_heads.aggregate_id
        FROM event_heads
        LEFT JOIN event_sequence ON event_sequence.aggregate_id = event_heads.aggregate_id
        WHERE event_sequence.aggregate_id IS NULL
      )
      SELECT
        (
          SELECT COUNT(DISTINCT event.aggregate_id)
          FROM event
          INNER JOIN event_sequence ON event_sequence.aggregate_id = event.aggregate_id
          WHERE event_sequence.owner_id IS NOT NULL
        ) AS ownedAggregates,
        (
          SELECT COUNT(DISTINCT event.aggregate_id)
          FROM event
          INNER JOIN session ON session.id = event.aggregate_id
          WHERE session.workspace_id IS NOT NULL
        ) AS workspaceAggregates,
        (
          SELECT COUNT(*)
          FROM (
            SELECT aggregate_id
            FROM event
            GROUP BY aggregate_id
            HAVING MIN(seq) <> 0 OR COUNT(*) <> MAX(seq) + 1
          )
        ) AS sequenceGaps,
        (SELECT COUNT(*) FROM head_mismatches) AS sequenceHeadMismatches,
        (
          SELECT COUNT(*)
          FROM shaped
          WHERE
            valid_json <> 1
            OR COALESCE(container_type, '') <> 'object'
            OR COALESCE(payload_session_type, '') <> 'text'
            OR COALESCE(entity_type, '') <> 'text'
            OR COALESCE(nested_session_type, '') <> 'text'
        ) AS invalidPayloads,
        (
          SELECT COUNT(*)
          FROM shaped
          WHERE
            valid_json = 1
            AND container_type = 'object'
            AND payload_session_type = 'text'
            AND entity_type = 'text'
            AND nested_session_type = 'text'
            AND (payload_session_id <> aggregate_id OR nested_session_id <> aggregate_id)
        ) AS aggregatePayloadMismatches,
        (
          SELECT COUNT(*)
          FROM event
          WHERE
            (
              type = 'session.updated'
              OR type GLOB 'session.updated.*'
              OR type = 'message.updated'
              OR type GLOB 'message.updated.*'
              OR type = 'message.part.updated'
              OR type GLOB 'message.part.updated.*'
            )
            AND type NOT IN ('session.updated.1', 'message.updated.1', 'message.part.updated.1')
        ) AS unsupportedSnapshotVersions
    `,
        )
        .pipe(Effect.orDie)

      return {
        dryRun: true,
        applySupported: false,
        total: total ?? { events: 0, payloadBytes: 0, aggregates: 0 },
        byType,
        repeatedSnapshots: {
          classification: "potential",
          events: repeatedByType.reduce((sum, row) => sum + row.events, 0),
          payloadBytes: repeatedByType.reduce((sum, row) => sum + row.payloadBytes, 0),
          byType: repeatedByType,
        },
        blockers: {
          checkpointProtocolUnavailable: true,
          ...(blockers ?? {
            ownedAggregates: 0,
            workspaceAggregates: 0,
            sequenceGaps: 0,
            sequenceHeadMismatches: 0,
            invalidPayloads: 0,
            aggregatePayloadMismatches: 0,
            unsupportedSnapshotVersions: 0,
          }),
        },
      } satisfies Report
    }),
  )
})
