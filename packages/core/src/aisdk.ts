export * as AISDK from "./aisdk"

import { makeLocationNode } from "./effect/app-node"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Cause, Context, Effect, Layer, Schema, Scope } from "effect"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { State } from "./state"
import { CHUNK_TIMEOUT_DEFAULT, HEADER_TIMEOUT_DEFAULT } from "@opencode-ai/llm"

type SDK = any

export interface SDKEvent {
  readonly model: ModelV2.Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: ModelV2.Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

function wrapBody(
  res: Response,
  ms: number,
  ctl: AbortController,
  metadata: ResponseMetadata = { url: res.url, redirected: res.redirected, type: res.type },
  state: BodyTimeoutState = { active: 0, cancelers: new Set(), finished: false },
): Response {
  if (typeof ms !== "number" || ms <= 0) return res
  if (res.bodyUsed) return res

  const source = res.body
  if (!source || source.locked) return res
  let raw: ReadableStream<Uint8Array<ArrayBuffer>> = source
  let reader: BodyReader | undefined
  let active = true
  const release = () => {
    if (!active) return state.active
    active = false
    state.cancelers.delete(cancelRaw)
    state.active -= 1
    return state.active
  }
  const cancelRaw = async (reason: unknown) => {
    release()
    await (reader ? reader.cancel(reason) : raw.cancel(reason))
  }
  state.active += 1
  state.cancelers.add(cancelRaw)

  const timeoutMessage = res.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ? "SSE read timed out"
    : "Provider response stream timed out"
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        if (state.error) {
          release()
          throw state.error
        }
        const current = (reader ??= raw.getReader())
        const part = await new Promise<Awaited<ReturnType<typeof current.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = state.error ?? new Error(timeoutMessage)
            state.error = err
            const cancelers = [...state.cancelers]
            ctl.abort(err)
            void Promise.allSettled(cancelers.map((cancel) => cancel(err)))
            reject(err)
          }, ms)

          current.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        }).catch((err) => {
          if (state.error) throw state.error
          release()
          throw err
        })

        if (state.error) {
          release()
          throw state.error
        }
        if (part.done) {
          if (active) state.finished = true
          release()
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        const remaining = release()
        if (remaining === 0 && !state.finished) ctl.abort(reason)
        await (reader ? reader.cancel(reason) : raw.cancel(reason))
      },
    },
    { highWaterMark: 0 },
  )

  const response = new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
  return responseMetadata(response, metadata, () => {
    if (response.bodyUsed || response.body?.locked) throw new TypeError("Response.clone: Body has already been used")
    const [left, right] = raw.tee()
    raw = left
    return wrapBody(
      new Response(right, {
        headers: new Headers(response.headers),
        status: response.status,
        statusText: response.statusText,
      }),
      ms,
      ctl,
      metadata,
      state,
    )
  })
}

type ResponseMetadata = Pick<Response, "url" | "redirected" | "type">
type BodyReader = {
  cancel(reason?: unknown): Promise<void>
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>
}
type BodyTimeoutState = {
  active: number
  cancelers: Set<(reason: unknown) => Promise<void>>
  error?: Error
  finished: boolean
}

function responseMetadata(response: Response, metadata: ResponseMetadata, clone: () => Response): Response {
  Object.defineProperties(response, {
    url: { configurable: true, value: metadata.url },
    redirected: { configurable: true, value: metadata.redirected },
    type: { configurable: true, value: metadata.type },
    clone: {
      configurable: true,
      writable: true,
      value: clone,
    },
  })
  return response
}

function prepareOptions(model: ModelV2.Info, pkg: string) {
  const options: Record<string, any> = {
    name: model.providerID,
    ...(model.api.type === "aisdk" ? (model.api.settings ?? {}) : {}),
    ...model.request.body,
  }
  if (model.api.type === "aisdk" && model.api.url) options.baseURL = model.api.url

  const customFetch = options.fetch
  const chunkTimeout = transportTimeout(options.chunkTimeout) ?? CHUNK_TIMEOUT_DEFAULT
  const headerTimeout = transportTimeout(options.headerTimeout) ?? HEADER_TIMEOUT_DEFAULT
  delete options.chunkTimeout
  delete options.headerTimeout
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const opts = { ...(init ?? {}) }
    const chunkAbortCtl = chunkTimeout === false ? undefined : new AbortController()

    if (
      (pkg === "@ai-sdk/openai" || pkg === "@ai-sdk/azure" || pkg === "@ai-sdk/amazon-bedrock/mantle") &&
      opts.body &&
      opts.method === "POST"
    ) {
      const body = JSON.parse(opts.body as string)
      if (body.store !== true && Array.isArray(body.input)) {
        for (const item of body.input) {
          if ("id" in item) delete item.id
        }
        opts.body = JSON.stringify(body)
      }
    }

    const signals = [
      opts.signal,
      chunkAbortCtl?.signal,
      options.timeout !== undefined && options.timeout !== null && options.timeout !== false
        ? AbortSignal.timeout(options.timeout)
        : undefined,
    ].filter((item): item is AbortSignal => Boolean(item))
    const res = await (async () => {
      const headerTimeoutCtl = headerTimeout === false ? undefined : timeoutController(headerTimeout)
      try {
        const allSignals = headerTimeoutCtl ? [...signals, headerTimeoutCtl.signal] : signals
        if (allSignals.length === 1) opts.signal = allSignals[0]
        if (allSignals.length > 1) opts.signal = AbortSignal.any(allSignals)
        return await (typeof customFetch === "function" ? customFetch : fetch)(input, {
          ...opts,
          timeout: false,
        })
      } finally {
        headerTimeoutCtl?.clear()
      }
    })()
    if (!chunkAbortCtl || chunkTimeout === false) return res
    return wrapBody(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

function transportTimeout(value: unknown): number | false | undefined {
  if (value === false) return false
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return undefined
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new Error(`Provider response headers timed out after ${ms}ms`)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("AISDK.InitError", {
  providerID: ProviderV2.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: ProviderV2.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: ModelV2.Info) => Effect.Effect<LanguageModelV3, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, LanguageModelV3>()
    const sdks = new Map<string, SDK>()

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const key = `${model.providerID}/${model.id}/${model.request.variant ?? "default"}`
        const existing = languages.get(key)
        if (existing) return existing
        if (model.api.type !== "aisdk")
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported api ${model.api.type}`),
          })

        const options = prepareOptions(model, model.api.package)
        const sdkKey = JSON.stringify({
          providerID: model.providerID,
          api: model.api,
          options,
        })
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: model.api.package, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, sdk)
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.api.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, language)
        return language
      }),
    })
    return service
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
