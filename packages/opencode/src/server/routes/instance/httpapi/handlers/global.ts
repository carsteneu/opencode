import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Deferred, Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalScopeInput, GlobalUpgradeInput } from "../groups/global"
import { sseConnect, sseDisconnect } from "../sse-counters"
import { sseDisconnectSignal } from "../sse-disconnect"
import { allowsForClient, clearScope, installScopeTracking, setScope } from "@/server/shared/scope"

// Open /global/event streams per client id. A client id normally has exactly one
// stream; the count makes eviction safe when a reconnect opens the new stream
// before the old one's finalizer runs.
const streams = new Map<string, number>()

// See event.ts for rationale. Same bounded-buffer + terminate-on-overflow
// semantics so a stuck SSE client cannot grow heap unboundedly.
const SSE_QUEUE_CAPACITY = 8192

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

// A client-supplied map key, kept only while it is plausibly one. See scopeUpdate.
function bounded(value: string | undefined, max: number) {
  if (value === undefined || value.length === 0 || value.length > max) return undefined
  return value
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse(clientID?: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const disconnect = yield* sseDisconnectSignal(request)
    const queue = yield* Queue.bounded<GlobalBusEvent>(SSE_QUEUE_CAPACITY)
      const overflow = yield* Deferred.make<void>()
      const handler = (event: GlobalBusEvent) => {
        // Opt-in isolation: a client that presented the client-id header is
        // filtered from its very first frame. The scope POST that carries the
        // directory/sessions arrives a few ms behind the stream, so until it
        // lands the client is treated as showing nothing — never as showing
        // everything. Subscribers without the header are untouched.
        if (!allowsForClient(clientID, event)) return
        if (!Queue.offerUnsafe(queue, event)) {
          Effect.runPromise(Deferred.succeed(overflow, undefined).pipe(Effect.ignore))
        }
      }
      yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
      const events = Stream.fromQueue(queue).pipe(
        Stream.interruptWhen(Deferred.await(disconnect)),
        Stream.interruptWhen(Deferred.await(overflow)),
      )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    const connectStats = yield* sseConnect()
    if (clientID) streams.set(clientID, (streams.get(clientID) ?? 0) + 1)
    yield* Effect.logInfo(
      `global event connected (active=${connectStats.active}, busListeners=${connectStats.listeners})`,
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Drop the scope once the client's last stream is gone so a long-lived
        // shared server does not accumulate one entry per window that ever ran.
        if (clientID) {
          const remaining = (streams.get(clientID) ?? 1) - 1
          if (remaining <= 0) {
            streams.delete(clientID)
            clearScope(clientID)
          } else {
            streams.set(clientID, remaining)
          }
        }
        const stats = yield* sseDisconnect()
        yield* Effect.logInfo(
          `global event disconnected (active=${stats.active}, busListeners=${stats.listeners})`,
        )
      }),
    )
    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    yield* Effect.sync(() => installScopeTracking())

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* eventResponse(request.headers["x-opencode-client-id"])
    })

    const scopeUpdate = Effect.fn("GlobalHttpApi.scope")(function* (ctx: { payload: typeof GlobalScopeInput.Type }) {
      // Bound every client-supplied key so this endpoint cannot grow the shared
      // server's scope maps without limit. An oversized value is treated as absent
      // rather than truncated, so a long one can never masquerade as a real key.
      if (ctx.payload.clientID.length === 0 || ctx.payload.clientID.length > 200) return false
      setScope(ctx.payload.clientID, {
        directory: bounded(ctx.payload.directory, 4096),
        project: bounded(ctx.payload.project, 200),
        sessions: ctx.payload.sessions.slice(0, 1000),
      })
      return true
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target || (yield* installation.latest(method, true))
      if (Installation.isPatched() && !Installation.isNewer(InstallationVersion, target)) {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: `Target must be newer than ${InstallationVersion}` },
          { status: 400 },
        )
      }
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      return yield* upgrade({ payload: payload.payload })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("scope", scopeUpdate)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
