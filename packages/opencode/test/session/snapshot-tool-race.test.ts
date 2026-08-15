/**
 * Reproducer for snapshot race condition with instant tool execution.
 *
 * When the mock LLM returns a tool call response instantly, the AI SDK
 * processes the tool call and executes the tool (e.g. apply_patch) before
 * the processor's start-step handler can capture a pre-tool snapshot.
 * Both the "before" and "after" snapshots end up with the same git tree
 * hash, so computeDiff returns empty and the session summary shows 0 files.
 *
 * This is a real bug: the snapshot system assumes it can capture state
 * before tools run by hooking into start-step, but the AI SDK executes
 * tools internally during multi-step processing before emitting events.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { EventTable } from "@opencode-ai/core/event/sql"
import { and, eq } from "drizzle-orm"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  EventV2Bridge.node,
  Snapshot.node,
  Database.node,
  MessageDiff.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

it.live("tool execution produces non-empty session diff (snapshot race)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const messageDiffs = yield* MessageDiff.Service
      const snapshot = yield* Snapshot.Service

      const session = yield* sessions.create({
        title: "snapshot race test",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Use bash tool (always registered) to create a file
      const command = `seq 1 5000 > ${path.join(dir, "race-test.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", {
        command,
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      // Seed user message
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })

      // Run the agent loop
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      // Verify the file was created
      const filePath = path.join(dir, "race-test.txt")
      const fileExists = yield* Effect.promise(() =>
        fs
          .access(filePath)
          .then(() => true)
          .catch(() => false),
      )
      expect(fileExists).toBe(true)

      // Verify the tool call completed (in the first assistant message)
      const allMsgs = yield* MessageV2.filterCompactedEffect(session.id)
      const user = allMsgs.find(
        (msg): msg is SessionV1.WithParts & { info: SessionV1.User } => msg.info.role === "user",
      )
      const tool = allMsgs
        .flatMap((m) => m.parts)
        .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "bash")
      expect(tool?.state.status).toBe("completed")
      if (!user) throw new Error("Expected user message")

      // Poll for the terminal turn diff after the processor finishes.
      let diff: Array<{ file?: string; patch?: string }> = []
      for (let i = 0; i < 50; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
      expect(diff[0]?.patch).toContain("+5000")
      expect(JSON.stringify(diff).length).toBeGreaterThan(20_000)

      const persisted = (yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)).find(
        (message) => message.info.id === user.info.id,
      )
      if (persisted?.info.role !== "user") throw new Error("Expected persisted user message")
      expect(persisted.info.summary?.diffs?.[0]?.patch).toBeUndefined()
      expect((yield* messageDiffs.get(user.info.id))?.diffs[0]?.patch).toContain("+5000")
      expect(yield* snapshot.diffPinned({ sessionID: session.id, messageID: user.info.id })).toBeUndefined()

      const summaryEvents = () =>
        database.db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(and(eq(EventTable.aggregate_id, session.id), eq(EventTable.type, "message.updated.1")))
          .all()
      const before = (yield* summaryEvents())
        .map((event) => JSON.stringify(event.data))
        .filter((event) => event.includes('"summary"'))
      for (let i = 0; i < 5; i++) {
        yield* summary.summarize({ sessionID: session.id, messageID: user.info.id })
      }
      const summarized = (yield* summaryEvents())
        .map((event) => JSON.stringify(event.data))
        .filter((event) => event.includes('"summary"'))
      expect(summarized.length).toBe(before.length)
      expect(summarized.every((event) => !event.includes('"patch"'))).toBe(true)
      expect(Math.max(...summarized.map((event) => event.length))).toBeLessThan(2_000)
      expect(
        Math.max(...summarized.map((event) => event.length)) - Math.min(...summarized.map((event) => event.length)),
      ).toBe(0)

      yield* Effect.all(
        Array.from({ length: 20 }, () => summary.summarize({ sessionID: session.id, messageID: user.info.id })),
        { concurrency: "unbounded" },
      )
      const coalesced = (yield* summaryEvents())
        .map((event) => JSON.stringify(event.data))
        .filter((event) => event.includes('"summary"'))
      expect(coalesced.length).toBe(summarized.length)

      const legacy = {
        ...user.info,
        id: MessageID.ascending(),
        summary: {
          diffs: [
            {
              file: "legacy.ts",
              patch: "legacy patch without snapshots",
              additions: 1,
              deletions: 0,
              status: "modified" as const,
            },
          ],
        },
      }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session.id, info: legacy })
      yield* summary.summarize({ sessionID: session.id, messageID: legacy.id })
      const preserved = (yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)).find(
        (message) => message.info.id === legacy.id,
      )
      if (preserved?.info.role !== "user") throw new Error("Expected legacy user message")
      expect(preserved.info.summary?.diffs?.[0]?.patch).toBe("legacy patch without snapshots")

      const forked = yield* sessions.fork({ sessionID: session.id })
      const forkedMessages = yield* sessions.messages({ sessionID: forked.id }).pipe(Effect.orDie)
      const forkedPinned = forkedMessages.find(
        (message) => message.info.role === "user" && message.info.summary?.diffs?.[0]?.file === "race-test.txt",
      )
      if (forkedPinned?.info.role !== "user") throw new Error("Expected forked pinned user message")
      expect(forkedPinned.info.summary?.diffs?.[0]?.patch).toBeUndefined()
      yield* messageDiffs.remove(user.info.id)
      expect((yield* summary.diff({ sessionID: forked.id, messageID: forkedPinned.info.id }))[0]?.patch).toContain(
        "+5000",
      )

      const forkedLegacy = forkedMessages.find(
        (message) => message.info.role === "user" && message.info.summary?.diffs?.[0]?.file === "legacy.ts",
      )
      if (forkedLegacy?.info.role !== "user") throw new Error("Expected forked legacy user message")
      expect(forkedLegacy.info.summary?.diffs?.[0]?.patch).toBeUndefined()
      expect((yield* summary.diff({ sessionID: forked.id, messageID: forkedLegacy.info.id }))[0]?.patch).toBe(
        "legacy patch without snapshots",
      )

      const pinOnlyFork = yield* sessions.fork({ sessionID: session.id })
      const pinOnlyMessages = yield* sessions.messages({ sessionID: pinOnlyFork.id }).pipe(Effect.orDie)
      const pinOnlyUser = pinOnlyMessages.find(
        (message) => message.info.role === "user" && message.info.summary?.diffs?.[0]?.file === "race-test.txt",
      )
      if (pinOnlyUser?.info.role !== "user") throw new Error("Expected pin-only user")
      const pinOnlyAssistant = pinOnlyMessages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === pinOnlyUser.info.id,
      )
      const pinOnlyStart = pinOnlyAssistant?.parts.find(
        (part): part is SessionV1.StepStartPart => part.type === "step-start" && part.snapshot !== undefined,
      )
      const pinOnlyFinish = pinOnlyAssistant?.parts.findLast(
        (part): part is SessionV1.StepFinishPart => part.type === "step-finish" && part.snapshot !== undefined,
      )
      if (!pinOnlyStart?.snapshot || !pinOnlyFinish?.snapshot) throw new Error("Expected pin-only snapshot range")
      yield* messageDiffs.remove(pinOnlyUser.info.id)
      yield* sessions.updateMessage({ ...pinOnlyUser.info, summary: undefined })
      expect(
        yield* snapshot.pinDiff({
          sessionID: pinOnlyFork.id,
          messageID: pinOnlyUser.info.id,
          from: pinOnlyStart.snapshot,
          to: pinOnlyFinish.snapshot,
        }),
      ).toBe(true)
      expect(yield* summary.materializeSession({ sessionID: pinOnlyFork.id })).toEqual([])
      expect((yield* messageDiffs.get(pinOnlyUser.info.id, pinOnlyFork.id))?.diffs[0]?.patch).toContain("+5000")

      const interruptedFork = yield* sessions.fork({ sessionID: session.id })
      const interruptedMessages = yield* sessions.messages({ sessionID: interruptedFork.id }).pipe(Effect.orDie)
      const interruptedUser = interruptedMessages.find(
        (message) => message.info.role === "user" && message.info.summary?.diffs?.[0]?.file === "race-test.txt",
      )
      if (interruptedUser?.info.role !== "user") throw new Error("Expected interrupted user")
      const interruptedAssistant = interruptedMessages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === interruptedUser.info.id,
      )
      if (interruptedAssistant?.info.role !== "assistant") throw new Error("Expected interrupted assistant")
      const interruptedStart = interruptedAssistant.parts.find(
        (part): part is SessionV1.StepStartPart => part.type === "step-start" && part.snapshot !== undefined,
      )
      const interruptedFinish = interruptedAssistant.parts.findLast(
        (part): part is SessionV1.StepFinishPart => part.type === "step-finish" && part.snapshot !== undefined,
      )
      if (!interruptedStart?.snapshot || !interruptedFinish?.snapshot)
        throw new Error("Expected interrupted snapshot range")
      yield* messageDiffs.remove(interruptedUser.info.id)
      const continued = {
        ...interruptedAssistant.info,
        id: MessageID.ascending(),
        sessionID: interruptedFork.id,
        parentID: interruptedUser.info.id,
        time: { created: Date.now() },
      } satisfies SessionV1.Assistant
      yield* sessions.updateMessage(continued)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: interruptedFork.id,
        messageID: continued.id,
        type: "step-start",
        snapshot: interruptedFinish.snapshot,
      })
      expect(
        yield* snapshot.pinDiff({
          sessionID: interruptedFork.id,
          messageID: interruptedUser.info.id,
          from: interruptedStart.snapshot,
          to: interruptedFinish.snapshot,
        }),
      ).toBe(true)
      expect(yield* summary.materializeSession({ sessionID: interruptedFork.id })).toContain(interruptedUser.info.id)
      expect(yield* messageDiffs.get(interruptedUser.info.id, interruptedFork.id)).toBeUndefined()
      yield* Effect.promise(() => Bun.write(path.join(dir, "interrupted-materialize.txt"), "interrupted\n"))
      const interruptedEnd = yield* snapshot.track()
      if (!interruptedEnd) throw new Error("Expected interrupted end snapshot")
      expect(
        yield* snapshot.pinDiff({
          sessionID: interruptedFork.id,
          messageID: interruptedUser.info.id,
          from: interruptedStart.snapshot,
          to: interruptedEnd,
        }),
      ).toBe(true)
      expect(yield* summary.materializeSession({ sessionID: interruptedFork.id })).toEqual([])
      const interruptedDiff = yield* messageDiffs.get(interruptedUser.info.id, interruptedFork.id)
      expect(interruptedDiff?.toSnapshot).toBeUndefined()
      expect(interruptedDiff?.diffs.find((diff) => diff.file === "race-test.txt")?.patch).toContain("+5000")
      expect(interruptedDiff?.diffs.find((diff) => diff.file === "interrupted-materialize.txt")?.patch).toContain(
        "+interrupted",
      )

      const removedFork = yield* sessions.fork({ sessionID: forked.id })
      const removedMessages = yield* sessions.messages({ sessionID: removedFork.id }).pipe(Effect.orDie)
      const removedUser = removedMessages.find(
        (message) => message.info.role === "user" && message.info.summary?.diffs?.[0]?.file === "race-test.txt",
      )
      if (removedUser?.info.role !== "user") throw new Error("Expected user in second fork")
      const removedAssistant = removedMessages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === removedUser.info.id,
      )
      if (!removedAssistant) throw new Error("Expected assistant in second fork")
      yield* sessions.removeMessage({ sessionID: removedFork.id, messageID: removedAssistant.info.id })
      expect(yield* messageDiffs.get(removedUser.info.id, removedFork.id)).toBeUndefined()
      const removedReloaded = (yield* sessions.messages({ sessionID: removedFork.id }).pipe(Effect.orDie)).find(
        (message) => message.info.id === removedUser.info.id,
      )
      if (removedReloaded?.info.role !== "user") throw new Error("Expected reloaded user in second fork")
      expect(removedReloaded.info.summary?.diffs).toBeUndefined()

      const forkedAssistant = forkedMessages.findLast(
        (message) => message.info.role === "assistant" && message.info.parentID === forkedPinned.info.id,
      )
      const start = forkedAssistant?.parts.find(
        (part): part is SessionV1.StepStartPart => part.type === "step-start" && part.snapshot !== undefined,
      )
      const finish = forkedAssistant?.parts.findLast(
        (part): part is SessionV1.StepFinishPart => part.type === "step-finish" && part.snapshot !== undefined,
      )
      if (!forkedAssistant || !start?.snapshot || !finish?.snapshot) throw new Error("Expected forked snapshot range")
      yield* messageDiffs.remove(forkedPinned.info.id)
      yield* snapshot.pinDiff({
        sessionID: forked.id,
        messageID: forkedPinned.info.id,
        from: start.snapshot,
        to: finish.snapshot,
      })
      yield* sessions.replacePart({
        id: finish.id,
        sessionID: forked.id,
        messageID: forkedAssistant.info.id,
        type: "text",
        text: "boundary replaced",
      })
      expect(yield* snapshot.diffPinned({ sessionID: forked.id, messageID: forkedPinned.info.id })).toBeUndefined()
      expect(yield* messageDiffs.get(forkedPinned.info.id, forked.id)).toBeUndefined()
      const replacedUser = (yield* sessions.messages({ sessionID: forked.id }).pipe(Effect.orDie)).find(
        (message) => message.info.id === forkedPinned.info.id,
      )
      if (replacedUser?.info.role !== "user") throw new Error("Expected user after boundary replacement")
      expect(replacedUser.info.summary?.diffs).toBeUndefined()
      expect(yield* summary.materializeSession({ sessionID: forked.id })).toContain(forkedPinned.info.id)
      expect(yield* messageDiffs.get(forkedPinned.info.id, forked.id)).toBeUndefined()
    }),
    { git: true, config: providerCfg },
  ),
)
