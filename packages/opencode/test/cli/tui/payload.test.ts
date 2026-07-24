import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { TuiPayload } from "@/server/shared/tui-payload"

const patch = "PATCH_SENTINEL_" + "x".repeat(10_000)
const messageUpdated = {
  directory: "/tmp/project",
  project: "proj_test",
  payload: {
    id: "evt_message",
    type: "message.updated",
    properties: {
      sessionID: "ses_test",
      info: {
        id: "msg_test",
        sessionID: "ses_test",
        role: "user",
        time: { created: 1 },
        summary: {
          title: "kept title",
          body: "kept body",
          diffs: [{ file: "src/index.ts", patch, additions: 1, deletions: 0, status: "modified" }],
        },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      },
    },
  },
} satisfies GlobalEvent

describe("private TUI payload projection", () => {
  test("removes patch text without mutating message metadata", () => {
    const projected = TuiPayload.event(messageUpdated)

    expect(projected).toBeDefined()
    if (!projected || projected.payload.type !== "message.updated") throw new Error("Expected message.updated")
    if (messageUpdated.payload.type !== "message.updated") throw new Error("Expected message.updated")

    expect(projected.payload.properties.info).not.toBe(messageUpdated.payload.properties.info)
    expect(projected.payload.properties.info.role).toBe("user")
    if (projected.payload.properties.info.role !== "user") throw new Error("Expected user message")
    expect(projected.payload.properties.info.summary).toMatchObject({ title: "kept title", body: "kept body" })
    expect(projected.payload.properties.info.summary?.diffs).toEqual([
      { file: "src/index.ts", additions: 1, deletions: 0, status: "modified" },
    ])
    expect(JSON.stringify(projected)).not.toContain("PATCH_SENTINEL")
    expect(messageUpdated.payload.properties.info.summary?.diffs[0]?.patch).toBe(patch)
  })

  test("drops sync events and preserves unrelated events", () => {
    const sync = {
      directory: "/tmp/project",
      payload: {
        id: "evt_sync",
        type: "sync",
        syncEvent: {
          id: "evt_session",
          type: "session.deleted.1",
          seq: 1,
          aggregateID: "ses_test",
          data: { sessionID: "ses_test", info: {} },
        },
      },
    } as GlobalEvent
    const disposed = {
      directory: "/tmp/project",
      payload: {
        id: "evt_disposed",
        type: "server.instance.disposed",
        properties: { directory: "/tmp/project" },
      },
    } satisfies GlobalEvent

    expect(TuiPayload.event(sync)).toBeUndefined()
    expect(TuiPayload.event(disposed)).toBe(disposed)
  })

  test("ignores malformed optional summary metadata", () => {
    const malformed = { role: "user", summary: {} }

    expect(TuiPayload.info(malformed)).toBe(malformed)
  })
})
