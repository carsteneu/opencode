import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, MessageDiff.node, SessionProjector.node])),
)
const sessionID = SessionV2.ID.make("ses_message_diff")

function projectMessages(messageIDs: ReadonlyArray<SessionV1.MessageID>, projectedSessionID = sessionID) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const session = SessionV1.SessionInfo.make({
      id: projectedSessionID,
      slug: "message-diff",
      projectID: Project.ID.global,
      directory: "/project",
      title: "message diff",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    yield* events.publish(SessionV1.Event.Created, { sessionID: projectedSessionID, info: session })
    yield* Effect.forEach(
      messageIDs,
      (messageID) =>
        events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: projectedSessionID,
          info: {
            id: messageID,
            sessionID: projectedSessionID,
            role: "user",
            time: { created: 2 },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          },
        }),
      { discard: true },
    )
    return { database, events, session }
  })
}

describe("MessageDiff", () => {
  it.effect("rejects null message IDs at the database boundary", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const exit = yield* database.db
        .run("INSERT INTO message_diff (message_id, revision, data) VALUES (NULL, 'test', '[]')")
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("distinguishes a stored empty diff from a missing row and retains its snapshot range", () =>
    Effect.gen(function* () {
      const messageID = SessionV1.MessageID.ascending("msg_message_diff_empty")
      yield* projectMessages([messageID])
      const messageDiff = yield* MessageDiff.Service

      expect(yield* messageDiff.get(messageID)).toBeUndefined()
      yield* messageDiff.put({ messageID, fromSnapshot: "tree-before", toSnapshot: "tree-after", diffs: [] })

      expect(yield* messageDiff.get(messageID)).toEqual({
        fromSnapshot: "tree-before",
        toSnapshot: "tree-after",
        diffs: [],
      })
    }),
  )

  it.effect("overwrites the complete stored range and diff payload", () =>
    Effect.gen(function* () {
      const messageID = SessionV1.MessageID.ascending("msg_message_diff_overwrite")
      yield* projectMessages([messageID])
      const messageDiff = yield* MessageDiff.Service
      const first = [
        {
          file: "src/first.ts",
          patch: "@@ -1 +1 @@\n-old\n+first",
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ] satisfies ReadonlyArray<FileDiff.Info>
      const second = [
        {
          file: "src/second.ts",
          patch: "@@ -0,0 +1 @@\n+second",
          additions: 1,
          deletions: 0,
          status: "added",
        },
      ] satisfies ReadonlyArray<FileDiff.Info>

      yield* messageDiff.put({ messageID, fromSnapshot: "tree-a", toSnapshot: "tree-b", diffs: first })
      yield* messageDiff.put({ messageID, fromSnapshot: "tree-c", toSnapshot: "tree-d", diffs: second })

      expect(yield* messageDiff.get(messageID)).toEqual({
        fromSnapshot: "tree-c",
        toSnapshot: "tree-d",
        diffs: second,
      })

      yield* messageDiff.put({ messageID, diffs: [] })
      expect(yield* messageDiff.get(messageID)).toEqual({ diffs: [] })
    }),
  )

  it.effect("copies an existing diff to another projected message", () =>
    Effect.gen(function* () {
      const sourceID = SessionV1.MessageID.ascending("msg_message_diff_copy_source")
      const targetID = SessionV1.MessageID.ascending("msg_message_diff_copy_target")
      yield* projectMessages([sourceID, targetID])
      const messageDiff = yield* MessageDiff.Service
      const diffs = [
        {
          file: "src/copied.ts",
          patch: "@@ -1 +1 @@\n-source\n+target",
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ] satisfies ReadonlyArray<FileDiff.Info>
      yield* messageDiff.put({ messageID: sourceID, fromSnapshot: "tree-source", toSnapshot: "tree-target", diffs })

      expect(yield* messageDiff.copy({ fromMessageID: sourceID, toMessageID: targetID })).toBe(true)
      expect(yield* messageDiff.get(targetID)).toEqual({
        fromSnapshot: "tree-source",
        toSnapshot: "tree-target",
        diffs,
      })
      expect(
        yield* messageDiff.copy({
          fromMessageID: SessionV1.MessageID.ascending("msg_message_diff_copy_missing"),
          toMessageID: targetID,
        }),
      ).toBe(false)
    }),
  )

  it.effect("removes a stored diff", () =>
    Effect.gen(function* () {
      const messageID = SessionV1.MessageID.ascending("msg_message_diff_remove")
      yield* projectMessages([messageID])
      const messageDiff = yield* MessageDiff.Service
      yield* messageDiff.put({ messageID, diffs: [] })

      yield* messageDiff.remove(messageID)

      expect(yield* messageDiff.get(messageID)).toBeUndefined()
    }),
  )

  it.effect("cascades diff removal when the projected parent message is removed", () =>
    Effect.gen(function* () {
      const messageID = SessionV1.MessageID.ascending("msg_message_diff_cascade")
      const projection = yield* projectMessages([messageID])
      const messageDiff = yield* MessageDiff.Service
      yield* messageDiff.put({ messageID, diffs: [] })

      expect(
        yield* projection.database.db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get(),
      ).toBeDefined()
      yield* projection.events.publish(SessionV1.Event.MessageRemoved, { sessionID, messageID })

      expect(
        yield* projection.database.db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get(),
      ).toBeUndefined()
      expect(yield* messageDiff.get(messageID)).toBeUndefined()
    }),
  )

  it.effect("lists and authoritatively replaces full and targeted session snapshots", () =>
    Effect.gen(function* () {
      const firstID = SessionV1.MessageID.ascending("msg_message_diff_replace_first")
      const secondID = SessionV1.MessageID.ascending("msg_message_diff_replace_second")
      const thirdID = SessionV1.MessageID.ascending("msg_message_diff_replace_third")
      yield* projectMessages([firstID, secondID, thirdID])
      const messageDiff = yield* MessageDiff.Service
      yield* messageDiff.put({ messageID: firstID, fromSnapshot: "tree-a", toSnapshot: "tree-b", diffs: [] })
      yield* messageDiff.put({ messageID: secondID, fromSnapshot: "tree-b", toSnapshot: "tree-c", diffs: [] })
      yield* messageDiff.put({ messageID: thirdID, fromSnapshot: "tree-c", toSnapshot: "tree-d", diffs: [] })

      const listed = yield* messageDiff.list({ sessionID, messageIDs: [secondID] })
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        messageID: secondID,
        fromSnapshot: "tree-b",
        toSnapshot: "tree-c",
        diffs: [],
      })
      expect(yield* messageDiff.manifest([sessionID])).toEqual([
        {
          sessionID,
          rows: expect.arrayContaining([
            { messageID: firstID, revision: expect.any(String) },
            { messageID: secondID, revision: listed[0]?.revision },
            { messageID: thirdID, revision: expect.any(String) },
          ]),
        },
      ])

      expect(
        yield* messageDiff.replace({
          sessionID,
          messageIDs: [firstID, secondID],
          rows: [
            {
              messageID: firstID,
              revision: "revision-new",
              fromSnapshot: "tree-new-a",
              toSnapshot: "tree-new-b",
              diffs: [],
            },
          ],
        }),
      ).toEqual([
        { messageID: firstID, present: true },
        { messageID: secondID, present: false },
      ])
      expect(yield* messageDiff.get(firstID)).toEqual({
        fromSnapshot: "tree-new-a",
        toSnapshot: "tree-new-b",
        diffs: [],
      })
      expect(yield* messageDiff.get(secondID)).toBeUndefined()
      expect(yield* messageDiff.get(thirdID)).toBeDefined()

      yield* messageDiff.replace({ sessionID, rows: [] })
      expect(yield* messageDiff.list({ sessionID })).toEqual([])
    }),
  )

  it.effect("rejects cross-session replacement rows atomically", () =>
    Effect.gen(function* () {
      const firstID = SessionV1.MessageID.ascending("msg_message_diff_replace_owner")
      const otherID = SessionV1.MessageID.ascending("msg_message_diff_replace_other")
      const otherSessionID = SessionV2.ID.make("ses_message_diff_other")
      yield* projectMessages([firstID])
      yield* projectMessages([otherID], otherSessionID)
      const messageDiff = yield* MessageDiff.Service
      yield* messageDiff.put({ messageID: firstID, fromSnapshot: "tree-a", toSnapshot: "tree-b", diffs: [] })

      const exit = yield* messageDiff
        .replace({
          sessionID,
          rows: [
            {
              messageID: otherID,
              revision: "revision-other",
              fromSnapshot: "tree-x",
              toSnapshot: "tree-y",
              diffs: [],
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* messageDiff.get(firstID)).toEqual({
        fromSnapshot: "tree-a",
        toSnapshot: "tree-b",
        diffs: [],
      })
      expect(yield* messageDiff.get(otherID)).toBeUndefined()
    }),
  )
})
