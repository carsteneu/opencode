import { beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID } from "../../src/session/schema"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function requestLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), [replacement])
}

function integrationLayer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(
    LayerNode.group([
      ShareNext.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
      MessageDiff.node,
    ]),
    [replacement],
  )
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request uses default URL when no enterprise config", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request()

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () => {
        const createRequests: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/api/share")) {
            createRequests.push(req)
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(json(req, { ok: true }))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })

          const result = yield* (yield* ShareNext.Service).create(session.id)

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://legacy-share.example.com/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = yield* share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(createRequests).toHaveLength(1)
          expect(createRequests[0].method).toBe("POST")
          expect(createRequests[0].url).toBe("https://legacy-share.example.com/api/share")
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          if (req.method === "POST") {
            return Effect.succeed(
              json(req, {
                id: "shr_abc",
                url: "https://legacy-share.example.com/share/abc",
                secret: "sec_123",
              }),
            )
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })
          const service = yield* ShareNext.Service

          yield* service.create(session.id)
          yield* service.remove(session.id)

          expect(yield* share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://legacy-share.example.com/api/share"],
            ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() => {
      const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))
      return Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* share(session.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(client)))
    }),
  )

  it.live("ShareNext coalesces rapid diff events into one delayed sync with latest data", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "a.ts",
                patch:
                  "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          })
          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "b.ts",
                patch:
                  "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                additions: 2,
                deletions: 0,
                status: "modified",
              },
            ],
          })
          yield* pollWithTimeout(
            Effect.sync(() => (seen.length === 1 ? true : undefined)),
            "timed out waiting for share sync",
            "5 seconds",
          )

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as {
            secret: string
            data: Array<{
              type: string
              data: Array<{
                file: string
                patch: string
                additions: number
                deletions: number
                status?: string
              }>
            }>
          }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0].type).toBe("session_diff")
          expect(body.data[0].data).toEqual([
            {
              file: "b.ts",
              patch:
                "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
              additions: 2,
              deletions: 0,
              status: "modified",
            },
          ])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live(
    "reconciles persisted full message diffs when sharing initializes",
    () =>
      provideTmpdirInstance(
        () => {
          const seen: string[] = []
          const client = HttpClient.make((req) => {
            if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
              seen.push(new TextDecoder().decode(req.body.body))
            }
            return Effect.succeed(json(req, { ok: true }))
          })

          return Effect.gen(function* () {
            const sessions = yield* Session.Service
            const messageDiffs = yield* MessageDiff.Service
            const info = yield* sessions.create({ title: "startup reconciliation" })
            const target = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: info.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderV2.ID.make("test"),
                modelID: ModelV2.ID.make("model"),
              },
              summary: {
                diffs: [{ file: "startup.ts", additions: 3, deletions: 1, status: "modified" }],
              },
            } satisfies SessionV1.User)
            const unrelated = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: info.id,
              role: "user",
              time: { created: Date.now() + 1 },
              agent: "build",
              model: {
                providerID: ProviderV2.ID.make("test"),
                modelID: ModelV2.ID.make("model"),
              },
              summary: {
                diffs: [{ file: "unrelated.ts", additions: 1, deletions: 0, status: "added" }],
              },
            } satisfies SessionV1.User)
            yield* messageDiffs.put({
              messageID: target.id,
              diffs: [
                {
                  file: "startup.ts",
                  patch: "persisted full patch",
                  additions: 3,
                  deletions: 1,
                  status: "modified",
                },
              ],
            })

            const { db } = yield* Database.Service
            yield* db
              .insert(SessionShareTable)
              .values({
                session_id: info.id,
                id: "shr_startup",
                url: "https://legacy-share.example.com/share/startup",
                secret: "sec_startup",
              })
              .run()
              .pipe(Effect.orDie)

            yield* (yield* ShareNext.Service).init()
            yield* pollWithTimeout(
              Effect.sync(() => (seen.length === 1 ? true : undefined)),
              "timed out waiting for startup share reconciliation",
              "5 seconds",
            )

            const payload = JSON.parse(seen[0]!) as {
              secret: string
              data: Array<{ type: string; data: SessionV1.Info }>
            }
            expect(payload.secret).toBe("sec_startup")
            expect(payload.data).toHaveLength(1)
            expect(payload.data[0]?.type).toBe("message")
            expect(payload.data[0]?.data.id).toBe(target.id)
            expect(payload.data[0]?.data.id).not.toBe(unrelated.id)
            const message = payload.data[0]?.data
            if (message?.role !== "user") throw new Error("expected reconciled shared user message")
            expect(message.summary?.diffs).toEqual([
              {
                file: "startup.ts",
                patch: "persisted full patch",
                additions: 3,
                deletions: 1,
                status: "modified",
              },
            ])
          }).pipe(Effect.provide(integrationLayer(client)))
        },
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    10_000,
  )

  it.live(
    "requeues transport failures without overwriting newer queued diff data",
    () =>
      provideTmpdirInstance(
        () => {
          const seen: string[] = []
          const release = Deferred.makeUnsafe<void>()
          const client = HttpClient.make((req) => {
            if (!req.url.endsWith("/sync") || req.body._tag !== "Uint8Array") {
              return Effect.succeed(json(req, { ok: true }))
            }

            seen.push(new TextDecoder().decode(req.body.body))
            if (seen.length > 1) return Effect.succeed(json(req, { ok: true }))
            return Deferred.await(release).pipe(
              Effect.andThen(
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req }),
                  }),
                ),
              ),
            )
          })

          return Effect.gen(function* () {
            const events = yield* EventV2Bridge.Service
            const sharing = yield* ShareNext.Service
            const sessions = yield* Session.Service
            const info = yield* sessions.create({ title: "retry diff" })

            yield* sharing.init()
            const { db } = yield* Database.Service
            yield* db
              .insert(SessionShareTable)
              .values({
                session_id: info.id,
                id: "shr_retry",
                url: "https://legacy-share.example.com/share/retry",
                secret: "sec_retry",
              })
              .run()
              .pipe(Effect.orDie)

            yield* events.publish(Session.Event.Diff, {
              sessionID: info.id,
              diff: [{ file: "old.ts", patch: "old patch", additions: 1, deletions: 0, status: "modified" }],
            })
            yield* pollWithTimeout(
              Effect.sync(() => (seen.length === 1 ? true : undefined)),
              "timed out waiting for failed share sync",
              "5 seconds",
            )

            yield* events.publish(Session.Event.Diff, {
              sessionID: info.id,
              diff: [{ file: "new.ts", patch: "new patch", additions: 2, deletions: 1, status: "modified" }],
            })
            yield* Deferred.succeed(release, undefined)
            yield* pollWithTimeout(
              Effect.sync(() => (seen.length === 2 ? true : undefined)),
              "timed out waiting for retried share sync",
              "10 seconds",
            )

            const payloads = seen.map(
              (body) =>
                JSON.parse(body) as {
                  data: Array<{
                    type: string
                    data: Array<{
                      file: string
                      patch: string
                      additions: number
                      deletions: number
                      status?: string
                    }>
                  }>
                },
            )
            expect(payloads[0].data.find((item) => item.type === "session_diff")?.data).toEqual([
              { file: "old.ts", patch: "old patch", additions: 1, deletions: 0, status: "modified" },
            ])
            expect(payloads[1].data.find((item) => item.type === "session_diff")?.data).toEqual([
              { file: "new.ts", patch: "new patch", additions: 2, deletions: 1, status: "modified" },
            ])
          }).pipe(Effect.provide(integrationLayer(client)))
        },
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    20_000,
  )

  it.live(
    "retries a terminal full message diff after a non-ok response",
    () =>
      provideTmpdirInstance(
        () => {
          const seen: string[] = []
          let failNext = false
          const client = HttpClient.make((req) => {
            if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
              seen.push(new TextDecoder().decode(req.body.body))
              if (failNext) {
                failNext = false
                return Effect.succeed(json(req, { error: "retry" }, 503))
              }
            }
            return Effect.succeed(json(req, { ok: true }))
          })

          return Effect.gen(function* () {
            const events = yield* EventV2Bridge.Service
            const messageDiffs = yield* MessageDiff.Service
            const sharing = yield* ShareNext.Service
            const sessions = yield* Session.Service
            const info = yield* sessions.create({ title: "message diff" })

            yield* sharing.init()
            const { db } = yield* Database.Service
            yield* db
              .insert(SessionShareTable)
              .values({
                session_id: info.id,
                id: "shr_diff",
                url: "https://legacy-share.example.com/share/diff",
                secret: "sec_diff",
              })
              .run()
              .pipe(Effect.orDie)

            const message = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: info.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderV2.ID.make("test"),
                modelID: ModelV2.ID.make("model"),
              },
              summary: {
                diffs: [{ file: "turn.ts", additions: 1, deletions: 0, status: "modified" }],
              },
            } satisfies SessionV1.User)
            yield* messageDiffs.put({
              messageID: message.id,
              diffs: [
                {
                  file: "turn.ts",
                  patch: "terminal full patch",
                  additions: 1,
                  deletions: 0,
                  status: "modified",
                },
              ],
            })

            yield* pollWithTimeout(
              Effect.sync(() => (seen.length === 1 ? true : undefined)),
              "timed out waiting for metadata share sync",
              "5 seconds",
            )
            const pending = JSON.parse(seen[0]!) as {
              data: Array<{ type: string; data: SessionV1.Info }>
            }
            const pendingMessage = pending.data.find((item) => item.type === "message")?.data
            if (pendingMessage?.role !== "user") throw new Error("expected pending shared user message")
            expect(pendingMessage.summary?.diffs?.[0]?.patch).toBeUndefined()

            failNext = true
            yield* events.publish(Session.Event.DiffUpdated, { sessionID: info.id, messageID: message.id })
            yield* pollWithTimeout(
              Effect.sync(() => (seen.length === 3 ? true : undefined)),
              "timed out waiting for retried terminal share sync",
              "10 seconds",
            )
            const terminal = JSON.parse(seen[1]!) as {
              data: Array<{ type: string; data: SessionV1.Info }>
            }
            const terminalMessage = terminal.data.find((item) => item.type === "message")?.data
            if (terminalMessage?.role !== "user") throw new Error("expected terminal shared user message")
            expect(terminalMessage.summary?.diffs?.[0]?.patch).toBe("terminal full patch")
            expect(seen[2]).toBe(seen[1])

            const retried = JSON.parse(seen[2]!) as {
              data: Array<{ type: string; data: SessionV1.Info }>
            }
            const retriedMessage = retried.data.find((item) => item.type === "message")?.data
            if (retriedMessage?.role !== "user") throw new Error("expected retried shared user message")
            expect(retriedMessage.summary?.diffs?.[0]?.patch).toBe("terminal full patch")
          }).pipe(Effect.provide(integrationLayer(client)))
        },
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
     20_000,
  )

  it.live("stops retrying a failing sync after MAX_ATTEMPTS and gives up (no infinite requeue)", () =>
    provideTmpdirInstance(
      () => {
        const original = {
          attempts: process.env.OPENCODE_SHARE_MAX_ATTEMPTS,
        }
        const seen: string[] = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push(new TextDecoder().decode(req.body.body))
            return Effect.succeed(json(req, { ok: true }, 500))
          }
          return Effect.succeed(json(req, { ok: true }))
        })
        return Effect.gen(function* () {
          process.env.OPENCODE_SHARE_MAX_ATTEMPTS = "2"

          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service
          const info = yield* session.create({ title: "bounds" })
          yield* share.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_b",
              url: "https://legacy-share.example.com/share/b",
              secret: "sec_b",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [{ file: "a.ts", patch: "patch-a", additions: 1, deletions: 0, status: "modified" }],
          })

          yield* pollWithTimeout(
            Effect.sync(() => (seen.length >= 2 ? true : undefined)),
            "timed out waiting for bounded sync attempts",
            "5 seconds",
          )
          // After the attempt cap the session gives up — it must not keep requeueing forever.
          yield* Effect.sleep(1_500)
          expect(seen.length).toBe(2)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (original.attempts === undefined) delete process.env.OPENCODE_SHARE_MAX_ATTEMPTS
              else process.env.OPENCODE_SHARE_MAX_ATTEMPTS = original.attempts
            }),
          ),
          Effect.provide(integrationLayer(client)),
        )
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
    20_000,
  )
})
