import { Deferred, Effect, Scope } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

/**
 * Returns a Deferred that resolves when the underlying SSE client disconnects.
 *
 * Production transport is `node:http` served via `@effect/platform-node`. Under
 * Bun, the node:http polyfill emits `close` on the IncomingMessage (req) when
 * the client disconnects, but does NOT emit `close` on the ServerResponse
 * (res), and the web Request's signal does not fire abort for streaming
 * responses (effect's `scopeTransferToStream` detaches the scope from the
 * handler fiber, so the abort listener registered in `HttpEffect.toWebHandler`
 * is a no-op on an already-complete fiber). The intended teardown path through
 * `@effect/platform-node`'s `nodeResponse.on("close")` therefore never fires.
 *
 * Hooking `request.source.on("close")` (Node IncomingMessage) is the only
 * reliable teardown vector under Bun. The web Request branch is defensive for
 * the generic effect HttpServer path used in some test setups.
 */
export function sseDisconnectSignal(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Deferred.Deferred<void>, never, HttpServerRequest.HttpServerRequest | Scope.Scope> {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    const source = (request as unknown as { source: unknown }).source

    if (isEventEmitter(source)) {
      const complete = () => {
        Effect.runPromise(Deferred.succeed(deferred, undefined).pipe(Effect.ignore))
      }
      if ((source as { destroyed?: boolean }).destroyed) {
        complete()
      } else {
        source.on("close", complete)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            source.off("close", complete)
          }),
        )
      }
    } else if (source instanceof Request && source.signal) {
      const complete = () => {
        Effect.runPromise(Deferred.succeed(deferred, undefined).pipe(Effect.ignore))
      }
      if (source.signal.aborted) {
        complete()
      } else {
        source.signal.addEventListener("abort", complete, { once: true })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            source.signal.removeEventListener("abort", complete)
          }),
        )
      }
    } else {
      yield* Effect.logWarning(
        "sseDisconnectSignal: request.source is neither an EventEmitter nor a Request — disconnect detection disabled",
      )
    }

    return deferred
  })
}

function isEventEmitter(value: unknown): value is EventEmitter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { on?: unknown }).on === "function" &&
    typeof (value as { off?: unknown }).off === "function"
  )
}

interface EventEmitter {
  on(event: "close", listener: () => void): this
  off(event: "close", listener: () => void): this
}
