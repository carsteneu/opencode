import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import path from "path"
import { Effect } from "effect"
import { hydrateSummaryDiffs, sanitize } from "../../src/cli/cmd/export"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionSummary.node,
      Snapshot.node,
      SessionProjector.node,
      MessageDiff.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const seedMetadataSummary = Effect.fn("test.export.seedMetadataSummary")(function* () {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const instance = yield* TestInstance
  const info = yield* sessions.create({ title: "private export session" })
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected a snapshot before the file change")

  const file = "private-export.txt"
  const secret = "portable export secret"
  yield* Effect.promise(() => Bun.write(path.join(instance.directory, file), `${secret}\n`))
  const after = yield* snapshot.track()
  if (!after) throw new Error("expected a snapshot after the file change")

  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: {
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test-model"),
    },
    time: { created: Date.now() },
    summary: {
      title: "private summary title",
      body: "private summary body",
      diffs: [{ file, additions: 1, deletions: 0, status: "added" }],
    },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: info.id,
    parentID: user.id,
    mode: "build",
    agent: "build",
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    path: { cwd: instance.directory, root: instance.directory },
    cost: 0,
    tokens,
    time: { created: Date.now() },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: info.id,
    messageID: assistant.id,
    type: "step-start",
    snapshot: before,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: info.id,
    messageID: assistant.id,
    type: "step-finish",
    reason: "stop",
    snapshot: after,
    cost: 0,
    tokens,
  })

  return {
    sessions,
    info,
    user,
    file,
    secret,
    messages: yield* sessions.messages({ sessionID: info.id }),
  }
})

it.instance(
  "hydrates metadata-only summary diffs in an export copy without persisting patches",
  Effect.gen(function* () {
    const seeded = yield* seedMetadataSummary()
    const messageDiffs = yield* MessageDiff.Service
    const snapshot = yield* Snapshot.Service
    const source = seeded.messages.find((message) => message.info.id === seeded.user.id)
    if (source?.info.role !== "user") throw new Error("expected the persisted user message")
    expect(source.info.summary?.diffs?.[0]?.patch).toBeUndefined()
    expect(yield* messageDiffs.get(seeded.user.id, seeded.info.id)).toBeUndefined()

    const exported = yield* hydrateSummaryDiffs({ info: seeded.info, messages: seeded.messages })
    const hydrated = exported.messages.find((message) => message.info.id === seeded.user.id)
    if (hydrated?.info.role !== "user") throw new Error("expected the exported user message")
    expect(hydrated).not.toBe(source)
    expect(hydrated.info.summary?.diffs?.[0]?.file).toBe(seeded.file)
    expect(hydrated.info.summary?.diffs?.[0]?.patch).toContain(seeded.secret)
    expect(source.info.summary?.diffs?.[0]?.patch).toBeUndefined()

    const persisted = (yield* seeded.sessions.messages({ sessionID: seeded.info.id })).find(
      (message) => message.info.id === seeded.user.id,
    )
    if (persisted?.info.role !== "user") throw new Error("expected the reloaded user message")
    expect(persisted.info.summary?.diffs?.[0]?.patch).toBeUndefined()
    expect(yield* messageDiffs.get(seeded.user.id, seeded.info.id)).toBeUndefined()
    expect(yield* snapshot.diffPinned({ sessionID: seeded.info.id, messageID: seeded.user.id })).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "redacts lazily hydrated summary file paths and patch contents",
  Effect.gen(function* () {
    const seeded = yield* seedMetadataSummary()
    const exported = yield* hydrateSummaryDiffs({ info: seeded.info, messages: seeded.messages })
    const hydrated = exported.messages.find((message) => message.info.id === seeded.user.id)
    if (hydrated?.info.role !== "user") throw new Error("expected the exported user message")
    expect(hydrated.info.summary?.diffs?.[0]?.patch).toContain(seeded.secret)

    const redacted = JSON.stringify(sanitize(exported))
    expect(redacted).toContain("[redacted:message-diff-file:0]")
    expect(redacted).toContain("[redacted:message-diff-patch:0]")
    expect(redacted).not.toContain(seeded.file)
    expect(redacted).not.toContain(seeded.secret)
    expect(hydrated.info.summary?.diffs?.[0]?.patch).toContain(seeded.secret)
  }),
  { git: true },
)
