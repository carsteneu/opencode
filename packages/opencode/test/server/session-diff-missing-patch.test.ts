/**
 * Regression test for the same bug class as #26574 (sibling of #26566 and
 * #26553). The Desktop app calls GET /session/<id>/diff; before #26574
 * the response was Schema-encoded against `Snapshot.FileDiff` with
 * `patch: Schema.String` (required), so any session whose stored
 * `summary_diffs` had a row without `patch` returned HTTP 400 and the
 * session never loaded. Legacy session-level diffs are no longer surfaced,
 * but the endpoint remains compatible and must still return successfully.
 *
 * This test inserts a session row with a missing-patch diff entry and
 * asserts that GET /session/<id>/diff returns 200 with empty data.
 */
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { MessageID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { TuiPayload } from "@/server/shared/tui-payload"
import { and, eq } from "drizzle-orm"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([Session.node, Storage.node, Database.node, EventV2Bridge.node, MessageDiff.node]),
    ),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function pathFor(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

const withSession = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.acquireRelease(Session.use.create(input), (created) => Session.use.remove(created.id).pipe(Effect.ignore))

describe("session diff with missing patch (#26574)", () => {
  it.instance(
    "GET /session/<id>/diff ignores legacy session-level diff storage",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "missing-patch" })

        // Mimic legacy/imported on-disk shape: a diff entry with no
        // `patch` text. Pre-fix the typed response encoder rejects
        // this and returns 400.
        yield* Storage.Service.use((storage) =>
          storage.write(["session_diff", session.id], [{ file: "legacy.txt", additions: 1, deletions: 0 }]),
        )

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )

        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "legacy durable messages retain full patches while TUI hydration omits them",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "turn-diff" })
        const database = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        const messageID = MessageID.ascending()
        const patch = "@@ -1 +1 @@\n-old\n+new"
        const legacy = {
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: 2 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            title: "turn title",
            body: "turn body",
            diffs: [{ file: "turn.ts", patch, additions: 1, deletions: 0, status: "modified" }],
          },
        } satisfies SessionV1.User

        // Historical versions published the full user message directly. Publish below
        // Session.updateMessage so this fixture exercises the real durable legacy shape.
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session.id, info: legacy })

        const projectedRow = yield* database.db
          .select()
          .from(MessageTable)
          .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, session.id)))
          .get()
        if (!projectedRow) throw new Error("Expected projected legacy message")
        const projected = Schema.decodeUnknownSync(SessionV1.Info)({
          ...projectedRow.data,
          id: projectedRow.id,
          sessionID: projectedRow.session_id,
        })
        if (projected.role !== "user") throw new Error("Expected projected user message")
        expect(projected.summary?.diffs?.[0]?.patch).toBe(patch)

        const durable = (yield* database.db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, session.id),
              eq(EventTable.type, EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)),
            ),
          )
          .all())
          .map((row) => Schema.decodeUnknownSync(SessionV1.Event.MessageUpdated.data)(row.data))
          .find((row) => row.info.id === messageID)
        if (!durable || durable.info.role !== "user") throw new Error("Expected durable legacy user message")
        expect(durable.info.summary?.diffs?.[0]?.patch).toBe(patch)

        const messagesPath = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`
        const tuiResponse = yield* requestInDirectory(messagesPath, test.directory, {
          headers: { [TuiPayload.HEADER]: TuiPayload.OMIT },
        })
        expect(tuiResponse.status).toBe(200)
        const tuiMessages = (yield* tuiResponse.json) as SessionV1.WithParts[]
        expect(tuiMessages[0]?.info).toMatchObject({
          id: messageID,
          summary: {
            title: "turn title",
            body: "turn body",
            diffs: [{ file: "turn.ts", additions: 1, deletions: 0, status: "modified" }],
          },
        })
        if (tuiMessages[0]?.info.role !== "user") throw new Error("Expected user message")
        expect(tuiMessages[0].info.summary?.diffs?.[0]?.patch).toBeUndefined()

        const initialResponse = yield* requestInDirectory(
          `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=100`,
          test.directory,
          { headers: { [TuiPayload.HEADER]: TuiPayload.OMIT } },
        )
        expect(initialResponse.status).toBe(200)
        const initialMessages = (yield* initialResponse.json) as SessionV1.WithParts[]
        const initialMessage = initialMessages.find((message) => message.info.id === messageID)?.info
        if (initialMessage?.role !== "user") throw new Error("Expected user message")
        expect(initialMessage.summary?.diffs?.[0]?.patch).toBeUndefined()

        const regularResponse = yield* requestInDirectory(messagesPath, test.directory)
        expect(regularResponse.status).toBe(200)
        const regularMessages = (yield* regularResponse.json) as SessionV1.WithParts[]
        if (regularMessages[0]?.info.role !== "user") throw new Error("Expected user message")
        expect(regularMessages[0].info.summary?.diffs?.[0]?.patch).toBe(patch)

        const response = yield* requestInDirectory(
          `${pathFor(SessionPaths.diff, { sessionID: session.id })}?messageID=${messageID}`,
          test.directory,
        )

        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([
          { file: "turn.ts", patch, additions: 1, deletions: 0, status: "modified" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "new message writes omit patch text from projection and durable event",
    () =>
      Effect.gen(function* () {
        const session = yield* withSession({ title: "bounded-turn-diff" })
        const database = yield* Database.Service
        const messageDiffs = yield* MessageDiff.Service
        const messageID = MessageID.ascending()
        const marker = "durable-patch-marker"
        const written = yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            title: "turn title",
            body: "turn body",
            diffs: [
              {
                file: "turn.ts",
                patch: `${marker}\n${"x".repeat(50_000)}`,
                additions: 1,
                deletions: 0,
                status: "modified",
              },
            ],
          },
        } satisfies SessionV1.User)

        if (written.role !== "user") throw new Error("Expected written user message")
        expect(written.summary).toEqual({
          title: "turn title",
          body: "turn body",
          diffs: [{ file: "turn.ts", additions: 1, deletions: 0, status: "modified" }],
        })

        const projectedRow = yield* database.db
          .select()
          .from(MessageTable)
          .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, session.id)))
          .get()
        if (!projectedRow) throw new Error("Expected projected user message")
        const projected = Schema.decodeUnknownSync(SessionV1.Info)({
          ...projectedRow.data,
          id: projectedRow.id,
          sessionID: projectedRow.session_id,
        })
        if (projected.role !== "user") throw new Error("Expected projected user message")
        expect(projected.summary).toEqual(written.summary)
        expect(JSON.stringify(projectedRow.data)).not.toContain(marker)

        const durable = (yield* database.db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, session.id),
              eq(EventTable.type, EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)),
            ),
          )
          .all())
          .map((row) => Schema.decodeUnknownSync(SessionV1.Event.MessageUpdated.data)(row.data))
          .find((row) => row.info.id === messageID)
        if (!durable || durable.info.role !== "user") throw new Error("Expected durable user message")
        expect(durable.info.summary).toEqual(written.summary)
        expect(JSON.stringify(durable)).not.toContain(marker)
        expect((yield* messageDiffs.get(messageID, session.id))?.diffs[0]?.patch).toContain(marker)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
