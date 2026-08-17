import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq, count } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessageContentTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const seedSession = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "segments",
        directory: "/project",
        title: "segments",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

// Publishes a full durable tool-call lifecycle against one assistant message.
const runTool = Effect.fn("test.runTool")(function* (
  service: EventV2.Service,
  sessionID: SessionV2.ID,
  assistantMessageID: SessionMessage.ID,
  callID: string,
  timestamp: DateTime.Utc,
) {
  yield* service.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    timestamp,
    assistantMessageID,
    callID,
    name: "bash",
  })
  yield* service.publish(SessionEvent.Tool.Called, {
    sessionID,
    timestamp,
    assistantMessageID,
    callID,
    tool: "bash",
    input: { command: callID },
    provider: { executed: false },
  })
  yield* service.publish(SessionEvent.Tool.Success, {
    sessionID,
    timestamp,
    assistantMessageID,
    callID,
    structured: { phase: "done" },
    content: [],
    provider: { executed: false },
    result: callID,
  })
})

describe("SessionProjector segments", () => {
  it.effect("stores assistant content as per-item segments with an empty header blob", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_segments_storage")
      yield* seedSession(sessionID)
      const assistantMessageID = SessionMessage.ID.make("msg_seg_assistant")
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model,
      })
      yield* runTool(service, sessionID, assistantMessageID, "call-a", DateTime.makeUnsafe(2))
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-x",
      })
      yield* service.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(4),
        textID: "text-x",
        text: "hello",
      })
      yield* runTool(service, sessionID, assistantMessageID, "call-b", DateTime.makeUnsafe(5))

      const header = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      // The header projection must not grow with the conversation: content stays empty.
      expect((header?.data as { content: unknown }).content).toEqual([])

      const items = yield* db
        .select({ item_id: SessionMessageContentTable.item_id, data: SessionMessageContentTable.data })
        .from(SessionMessageContentTable)
        .where(eq(SessionMessageContentTable.message_id, assistantMessageID))
        .orderBy(asc(SessionMessageContentTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(items.map((row) => row.item_id)).toEqual(["call-a", "text-x", "call-b"])
      // The durable text segment holds the full value, independent of sibling segments.
      expect((items[1]!.data as { text: string }).text).toBe("hello")
    }),
  )

  it.effect("keeps the header projection bounded as tool count grows (O(T) byte growth)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_segments_growth")
      yield* seedSession(sessionID)
      const assistantMessageID = SessionMessage.ID.make("msg_seg_growth")
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model,
      })
      const tools = 100
      for (let i = 0; i < tools; i++) {
        yield* runTool(service, sessionID, assistantMessageID, `call-${i}`, DateTime.makeUnsafe(i + 2))
      }
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(tools + 2),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const header = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      expect((header?.data as { content: unknown }).content).toEqual([])
      // Body is header metadata only; with 100 tool results the inline blob must
      // stay small instead of accumulating the conversation.
      expect(JSON.stringify(header?.data).length).toBeLessThan(2000)

      const { total } = (yield* db
        .select({ total: count() })
        .from(SessionMessageContentTable)
        .where(eq(SessionMessageContentTable.message_id, assistantMessageID))
        .get()
        .pipe(Effect.orDie))!
      expect(total).toBe(tools)
    }),
  )

  it.effect("hydrates segments back into the previous inline content shape (equivalence)", () =>
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_segments_equiv")
      yield* seedSession(sessionID)
      const assistantMessageID = SessionMessage.ID.make("msg_seg_equiv")
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model,
      })
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        textID: "text-x",
      })
      yield* service.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-x",
        text: "line",
      })
      yield* runTool(service, sessionID, assistantMessageID, "call-c", DateTime.makeUnsafe(4))

      const content = yield* Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const messages = yield* sessions.messages({ sessionID, order: "asc" })
        return messages.find((message) => message.type === "assistant")
      }).pipe(Effect.provide(sessionsLayer))
      expect(content).toBeTruthy()
      expect(content?.type === "assistant" && content.content.map((item) => [item.type, item.id])).toEqual([
        ["text", "text-x"],
        ["tool", "call-c"],
      ])
      const first = content?.type === "assistant" ? content.content[0] : undefined
      expect(first && first.type === "text" ? first.text : undefined).toBe("line")
    }),
  )

  it.effect("projects concurrent sessions without cross-contaminating segments", () =>
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      const a = SessionV2.ID.make("ses_segments_concurrent_a")
      const b = SessionV2.ID.make("ses_segments_concurrent_b")
      yield* seedSession(a)
      yield* seedSession(b)
      const assistantA = SessionMessage.ID.make("msg_seg_ca")
      const assistantB = SessionMessage.ID.make("msg_seg_cb")
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID: a,
        assistantMessageID: assistantA,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model,
      })
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID: b,
        assistantMessageID: assistantB,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model,
      })
      yield* runTool(service, a, assistantA, "call-aa", DateTime.makeUnsafe(2))
      yield* runTool(service, b, assistantB, "call-bb", DateTime.makeUnsafe(2))

      const contents = yield* Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const [mA, mB] = yield* Effect.all(
          [sessions.messages({ sessionID: a, order: "asc" }), sessions.messages({ sessionID: b, order: "asc" })],
          { concurrency: "unbounded" },
        )
        const contentOf = (messages: typeof mA) =>
          messages.find((message): message is SessionMessage.Assistant => message.type === "assistant")?.content
        return { a: contentOf(mA)?.map((item) => item.id), b: contentOf(mB)?.map((item) => item.id) }
      }).pipe(Effect.provide(sessionsLayer))
      expect(contents.a).toEqual(["call-aa"])
      expect(contents.b).toEqual(["call-bb"])
    }),
  )
})
