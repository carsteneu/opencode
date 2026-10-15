export * as Mcp from "./index.js"

import { Mcp } from "@opencode/schema/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { ephemeral } from "@opencode/schema/event"
import type { Session } from "@opencode/schema/session"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Context, Effect, Exit, Fiber, FiberSet, Latch, Layer, Schema, Scope, Semaphore, Stream, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Credential } from "../credential.js"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { Form } from "../form.js"
import { Integration } from "../integration.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Location } from "../location.js"
import { waitForAbort } from "@opencode/util/process"
import { State } from "../state.js"
import type { McpClient } from "./client.js"

export const ServerName = Schema.String.pipe(Schema.brand("MCP.ServerName"))
export type ServerName = typeof ServerName.Type
export const PromptsChanged = ephemeral({ type: "mcp.prompts.changed", schema: { server: Schema.String } })

export const Status = Mcp.Status
export type Status = Mcp.Status
export type ServerInfo = Mcp.Server

export interface ServerInstructions {
  readonly server: ServerName
  readonly instructions: string
}

/** SDK tool definition tagged with the server that owns it. */
export type Tool = McpClient.Tool & { readonly server: ServerName; readonly codemode?: boolean }
export type ToolResultContent = McpClient.CallToolContent
export type ToolResult = McpClient.CallToolResult & { readonly server: ServerName; readonly tool: string }
export type Prompt = McpClient.Prompt & { readonly server: ServerName }
export type PromptResult = McpClient.GetPromptResult & { readonly server: ServerName; readonly name: string }

export const Resource = Mcp.Resource
export type Resource = Mcp.Resource
export const ResourceTemplate = Mcp.ResourceTemplate
export type ResourceTemplate = Mcp.ResourceTemplate
export const ResourceCatalog = Mcp.ResourceCatalog
export type ResourceCatalog = Mcp.ResourceCatalog
export const ResourceContent = Mcp.ResourceContent
export type ResourceContent = Mcp.ResourceContent

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("MCP.NotFoundError", {
  server: ServerName,
}) {
  override get message() {
    return `MCP server not found: ${this.server}`
  }
}

export class ToolCallError extends Schema.TaggedError<ToolCallError>()("MCP.ToolCallError", {
  server: ServerName,
  tool: Schema.String,
  message: Schema.String,
}) {}

// Auto-reconnect: a server that fails or loses its connection retries on a piecewise schedule,
// giving up only after `maxAttempts` failed attempts. Bands by upcoming attempt number, in groups
// of `bandSize`: 1-10 every 10s, 11-20 every 100s, 21-30 every 10min, 31-40 every 1h, 41-100 every
// 6h. Jitter spreads retries so many servers do not reconnect in lockstep.
const RECONNECT_MAX_ATTEMPTS = 100
const RECONNECT_BANDS = [10_000, 100_000, 600_000, 3_600_000, 21_600_000]
const RECONNECT_BAND_SIZE = 10
const RECONNECT_JITTER = () => 0.8 + Math.random() * 0.4

/** Automatic-reconnect schedule; every field falls back to the production value below. */
export interface Reconnect {
  /** Failed attempts before the episode is abandoned. */
  readonly maxAttempts?: number
  /** Wait in ms for each group of `bandSize` attempts; the last band covers the remaining attempts. */
  readonly bands?: ReadonlyArray<number>
  readonly bandSize?: number
  /** Multiplies the band wait. */
  readonly jitter?: () => number
}

const bandDelay = (bands: ReadonlyArray<number>, bandSize: number, attempt: number) =>
  bands[Math.min(Math.floor((attempt - 1) / bandSize), bands.length - 1)]

const formatDelay = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`
  return `${Math.round(ms / 3_600_000)}h`
}

const unavailable = (server: ServerName, status: Status) => {
  switch (status.status) {
    case "failed":
      return `MCP server "${server}" is not connected: ${status.error}. Reconnect it from /mcps.`
    case "needs_auth":
      return `MCP server "${server}" needs authentication: ${status.error}. Sign in from /mcps.`
    case "disabled":
      return `MCP server "${server}" is disabled.`
    default:
      return `MCP server "${server}" is not connected.`
  }
}

type ServerEntry = {
  readonly config: Mcp.ServerConfig
  status: Status
  readonly startup: Latch.Latch
  scope?: Scope.Closeable
  client?: McpClient.Connection
  tools?: ReadonlyArray<Tool>
  prompts?: ReadonlyArray<Prompt>
  // Set when a remote server is registered as an OAuth integration; the credential lives in the global store.
  integrationID?: Integration.ID
  registration?: State.Registration
}

// MCP elicitations are Location-scoped, not Session-scoped: the server cannot attribute them to a
// persisted session row, so their forms are owned by this opaque sentinel session identifier.
const GLOBAL_ELICITATION_SESSION_ID = "global"
const URL_ELICITATION_FIELD_KEY = "elicitation"
// Connections remain Location-scoped, but shared remote endpoints should not receive concurrent startup bursts.
const endpointLoads = KeyedMutex.makeUnsafe<string>()

type Data = {
  servers: Map<ServerName, Types.DeepMutable<Mcp.ServerConfig>>
  removed: Set<ServerName>
}

// One automatic-reconnect episode per server; an entry present in `episodes` means a scheduler runs.
type ReconnectEpisode = {
  /** Failed attempts in this episode; the upcoming attempt is `attempt + 1`. */
  attempt: number
  fiber?: Fiber.Fiber<void>
  /** Latest failure cause without the retry hint, so giving up can restore it. */
  error: string
}

export type Editor = {
  list: () => readonly [ServerName, Types.DeepMutable<Mcp.ServerConfig>][]
  get: (server: ServerName | string) => Types.DeepMutable<Mcp.ServerConfig> | undefined
  set: (server: ServerName | string, config: Mcp.ServerConfig) => void
  update: (server: ServerName | string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void) => void
  remove: (server: ServerName | string) => void
}

const cloneConfig = (config: Mcp.ServerConfig) => structuredClone(config) as Types.DeepMutable<Mcp.ServerConfig>

export interface Interface extends State.Transformable<Editor> {
  readonly servers: () => Effect.Effect<ServerInfo[]>
  readonly add: (server: ServerName | string, config: Mcp.ServerConfig) => Effect.Effect<void>
  readonly connect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly remove: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly tools: () => Effect.Effect<Tool[]>
  readonly callTool: (input: {
    readonly server: ServerName | string
    readonly name: string
    readonly args?: Record<string, unknown>
    readonly sessionID?: Session.ID
  }) => Effect.Effect<ToolResult, NotFoundError | ToolCallError>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly prompts: () => Effect.Effect<Prompt[]>
  readonly prompt: (input: {
    readonly server: ServerName | string
    readonly name: string
    readonly args?: Record<string, string>
  }) => Effect.Effect<PromptResult | undefined, NotFoundError>
  readonly resourceCatalog: () => Effect.Effect<ResourceCatalog>
  readonly resources: (input: { readonly server: ServerName | string }) => Effect.Effect<ResourceCatalog, Error>
  readonly readResource: (input: {
    readonly server: ServerName | string
    readonly uri: string
  }) => Effect.Effect<ResourceContent | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const Options = Schema.Struct({
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  ),
})
// The reconnect schedule is passed as a plain option rather than a schema field: it is a function
// of construction-time policy, not of decoded configuration.
export type Options = typeof Options.Type & { readonly reconnect?: Reconnect }

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const environment = yield* Environment.Service
      const bus = yield* Bus.Service
      const forms = yield* Form.Service
      const integration = yield* Integration.Service
      const credentials = yield* Credential.Service
      const root = yield* Effect.scope
      const fork = yield* FiberSet.makeRuntime<never, void, never>()

      const entries = new Map<ServerName, ServerEntry>()
      // Serializes lifecycle operations per server. Anything taking this lock from a connection
      // callback must stay forked: lifecycle operations close scopes while holding it, firing onClose.
      const locks = KeyedMutex.makeUnsafe<ServerName>()
      // Automatic-reconnect schedulers, at most one per server.
      const episodes = new Map<ServerName, ReconnectEpisode>()
      let disposed = false
      const requested = options?.reconnect
      const retry = {
        maxAttempts: requested?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS,
        // An empty band list would mean "no attempts at all", which is never what a caller means.
        bands: requested?.bands?.length ? requested.bands : RECONNECT_BANDS,
        bandSize: requested?.bandSize ?? RECONNECT_BAND_SIZE,
        jitter: requested?.jitter ?? RECONNECT_JITTER,
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // The scheduler fibers are interrupted with this layer's fiber set; clearing the registry
          // first only keeps a teardown from arming another episode.
          disposed = true
          episodes.clear()
        }),
      )
      // Legacy era only: pending URL-mode elicitation forms, settled by notifications/elicitation/complete.
      const urlElicitations = new Map<string, Form.ID>()

      // Register every remote server as an OAuth integration so credentials live in the global store
      // rather than in committed config. Servers that connect anonymously simply never use the method.
      const owned = new Set<Integration.ID>()
      const register = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        if (entry.config.type !== "remote" || entry.config.oauth === false) return
        const remote = entry.config
        // Key identity on name + url, not url alone: two configs for the same url under different names are
        // distinct logical servers that may hold different accounts, so they must not share a credential row.
        const suffix =
          "mcp_" +
          createHash("sha1")
            .update(name + "\u0000" + remote.url)
            .digest("hex")
            .slice(0, 16)
        const integrationID = Integration.ID.make(suffix)
        entry.integrationID = integrationID
        owned.add(integrationID)
        const methodID = Integration.MethodID.make(suffix)
        // Each registration gets its own child scope so disposal detaches it from the root scope
        // entirely; registering directly on root would accumulate a dead finalizer per replaced or
        // removed server for the lifetime of the layer.
        const scope = yield* Scope.fork(root)
        entry.registration = { dispose: Scope.close(scope, Exit.void) }
        yield* integration
          .transform((editor) => {
            editor.update(integrationID, (ref) => {
              ref.name = name
              ref.metadata = { source: "mcp" }
            })
            editor.method.update({
              integrationID,
              method: { id: methodID, type: "oauth", label: name },
              authorize: () =>
                Effect.gen(function* () {
                  const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
                  return yield* McpOAuth.authorize({ name, config: remote, integrationID, methodID }).pipe(
                    Effect.provideService(Credential.Service, credentials),
                  )
                }),
            })
          })
          .pipe(Scope.provide(scope))
      })
      const requireServer = Effect.fnUntraced(function* (server: ServerName | string) {
        const name = ServerName.make(server)
        const entry = entries.get(name)
        if (!entry) return yield* new NotFoundError({ server: name })
        return { name, entry }
      })

      const connectProvider = Effect.fnUntraced(function* (entry: ServerEntry) {
        if (entry.config.type !== "remote" || !entry.integrationID) return undefined
        const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
        return yield* McpOAuth.connectProvider({ config: entry.config, integrationID: entry.integrationID }).pipe(
          Effect.provideService(Credential.Service, credentials),
        )
      })

      const elicitation = {
        create: (input: {
          readonly server: string
          readonly params: McpClient.ElicitationParams
          readonly signal: AbortSignal
        }) =>
          Effect.gen(function* () {
            if (input.params.mode === "url") {
              const formID = Form.ID.create()
              // Legacy only: 2026-07-28 has no elicitationId and no completion notification, so the form
              // settles when the user confirms and the SDK retries the tool call itself.
              const elicitationID: string | undefined = input.params.elicitationId
              const key = elicitationID === undefined ? undefined : input.server + "\u0000" + elicitationID
              if (key) urlElicitations.set(key, formID)
              return yield* forms
                .ask({
                  id: formID,
                  sessionID: GLOBAL_ELICITATION_SESSION_ID,
                  title: `${input.server} is requesting input`,
                  metadata: {
                    kind: "mcp-elicitation",
                    server: input.server,
                    ...(elicitationID === undefined ? {} : { elicitationID }),
                    message: input.params.message,
                  },
                  fields: [{ key: URL_ELICITATION_FIELD_KEY, type: "external", url: input.params.url }],
                })
                .pipe(
                  Effect.raceFirst(waitForAbort(input.signal)),
                  Effect.ensuring(Effect.sync(() => key && urlElicitations.delete(key))),
                  Effect.map(
                    (state): McpClient.ElicitationResult => ({
                      action: state.status === "answered" ? "accept" : "cancel",
                    }),
                  ),
                )
            }
            const params = input.params
            const [field, ...fields] = Object.entries(params.requestedSchema.properties).map(([key, property]) =>
              toElicitationField(key, property, params.requestedSchema.required?.includes(key) === true),
            )
            if (!field) return { action: "accept", content: {} }
            return yield* forms
              .ask({
                sessionID: GLOBAL_ELICITATION_SESSION_ID,
                title: `${input.server} is requesting input`,
                metadata: { kind: "mcp-elicitation", server: input.server, message: params.message },
                fields: [field, ...fields],
              })
              .pipe(
                Effect.raceFirst(waitForAbort(input.signal)),
                Effect.map((state): McpClient.ElicitationResult => {
                  if (state.status !== "answered") return { action: "cancel" }
                  return {
                    action: "accept",
                    content: Object.fromEntries(
                      Object.entries(state.answer).map(
                        ([key, value]): [string, NonNullable<McpClient.ElicitationResult["content"]>[string]] =>
                          typeof value === "object" ? [key, Array.from(value)] : [key, value],
                      ),
                    ),
                  }
                }),
              )
          }),
        complete: (input: { readonly server: string; readonly elicitationID: string }) =>
          Effect.gen(function* () {
            const formID = urlElicitations.get(input.server + "\u0000" + input.elicitationID)
            if (!formID) return
            yield* forms.reply({ id: formID, answer: { [URL_ELICITATION_FIELD_KEY]: true } }).pipe(Effect.ignore)
          }),
      } satisfies McpClient.ElicitationHandler

      const toTool = (server: ServerName, entry: ServerEntry, tool: McpClient.Tool): Tool => ({
        ...tool,
        server,
        ...(entry.config.codemode === undefined ? {} : { codemode: entry.config.codemode }),
      })

      const refreshTools = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        connection.tools().pipe(
          Effect.map((tools) => {
            entry.tools = tools.map((tool) => toTool(name, entry, tool))
          }),
        )

      const refreshPrompts = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        connection.prompts().pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((prompts) => {
            entry.prompts = prompts.map((prompt): Prompt => ({ ...prompt, server: name }))
          }),
          Effect.andThen(bus.publish(PromptsChanged, { server: name })),
        )

      // Runs a connection callback under the server lock, dropping it if the connection is no longer
      // the entry's live client, so late SDK callbacks cannot commit obsolete state.
      const whenLive =
        (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        <E>(effect: Effect.Effect<void, E>) =>
          fork(
            Effect.suspend(() => (entry.client === connection ? effect : Effect.void)).pipe(
              locks.withLock(name),
              Effect.ignore,
            ),
          )

      // Re-establishes a server whose HTTP session the server dropped, unless another path already
      // replaced the connection while this one waited for the lock.
      const recover = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        Effect.gen(function* () {
          if (entry.client !== connection) return
          yield* Effect.logInfo("mcp session expired, reconnecting", { server: name })
          yield* stopServer(name, entry)
          yield* startServer(name, entry)
        }).pipe(locks.withLock(name))

      // Runs a request against the live connection and, if that request observed a session expiry,
      // reconnects and runs it once more against the replacement. Any other failure passes through.
      const recovering = <A, E extends Error>(
        name: ServerName,
        entry: ServerEntry,
        connection: McpClient.Connection,
        run: (connection: McpClient.Connection) => Effect.Effect<A, E>,
      ) =>
        run(connection).pipe(
          Effect.catchIf(
            // The client module is loaded lazily, so match the tagged error by tag rather than class.
            (error) => "_tag" in error && error._tag === "MCP.SessionExpiredError",
            (error) =>
              recover(name, entry, connection).pipe(
                Effect.flatMap(() => (entry.client ? run(entry.client) : Effect.fail(error))),
              ),
          ),
        )

      // A successful connection ends any pending retry, but only while that connection is still the
      // live one: a server that flaps during startup has already armed a fresh episode, and clearing
      // that one would leave the server dead. It never interrupts, because the scheduler may be the
      // caller; the loop notices the removed registry entry and returns.
      const settleEpisode = (name: ServerName, connection: McpClient.Connection) =>
        Effect.sync(() => {
          if (entries.get(name)?.client === connection) episodes.delete(name)
        })

      // Interrupts a scheduler other than the calling fiber. An attempt may replace its own server,
      // and interrupting its own fiber there would deadlock the episode.
      const cancelEpisode = Effect.fnUntraced(function* (name: ServerName) {
        const episode = episodes.get(name)
        if (!episode) return
        const fiber = episode.fiber
        if (fiber && fiber.id === (yield* Effect.fiberId)) return
        episodes.delete(name)
        if (fiber) yield* Fiber.interrupt(fiber)
      })

      // Retries ran out: the server keeps its last failure without the retry hint, so the original
      // cause stays readable and the user can reconnect from /mcps once the configuration is fixed.
      const giveUpEpisode = Effect.fnUntraced(function* (name: ServerName, episode: ReconnectEpisode) {
        episodes.delete(name)
        const entry = entries.get(name)
        if (entry) {
          entry.status = { status: "failed", error: episode.error }
          yield* bus.publish(McpEvent.StatusChanged, { server: name })
        }
        yield* Effect.logWarning("MCP reconnect abandoned", { server: name, attempts: retry.maxAttempts })
      })

      const retryServer = Effect.fnUntraced(function* (name: ServerName, episode: ReconnectEpisode) {
        while (true) {
          if (disposed || episodes.get(name) !== episode) return
          const attempt = episode.attempt + 1
          const delay =
            attempt > retry.maxAttempts ? undefined : bandDelay(retry.bands, retry.bandSize, attempt)
          if (delay === undefined) return yield* giveUpEpisode(name, episode)
          const wait = Math.round(delay * retry.jitter())
          if (attempt > 1 && bandDelay(retry.bands, retry.bandSize, attempt - 1) !== delay) {
            yield* Effect.logWarning("MCP reconnect slowed down", {
              server: name,
              nextAttempt: attempt,
              every: formatDelay(delay),
            })
          }
          const entry = entries.get(name)
          if (entry?.status.status === "failed") {
            entry.status = {
              status: "failed",
              error: `${episode.error} — retry ${attempt}/${retry.maxAttempts} in ${formatDelay(wait)}`,
            }
            // The hint is the only signal that retries continue, so it has to reach the subscribers
            // that drive the sidebar and the /mcps dialog rather than sit unread until the attempt ends.
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
          }
          yield* Effect.sleep(wait)
          if (disposed || episodes.get(name) !== episode) return
          // The configuration is resolved again for every attempt, so a corrected, disabled or
          // removed server is picked up instead of being retried against a stale one.
          const config = state.get().servers.get(name)
          const current = entries.get(name)
          if (!config || config.disabled || !current) {
            episodes.delete(name)
            if (current?.status.status === "failed") {
              current.status = { status: "failed", error: episode.error }
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
            }
            return
          }
          // The lock covers the attempt only: holding it across the wait would block every other
          // lifecycle operation on this server for up to six hours.
          yield* locks.withLock(name)(
            isDeepStrictEqual(current.config, config)
              ? stopServer(name, current).pipe(Effect.andThen(startServer(name, current)))
              : replaceServer(name, config),
          )
          // A replaced or settled episode must not commit over the one that replaced it.
          if (disposed || episodes.get(name) !== episode) return
          const settled = entries.get(name)
          // Only a plain failure keeps the episode going; a connection that came up, or a server
          // waiting for authentication, ends it.
          if (settled?.status.status !== "failed") {
            episodes.delete(name)
            return
          }
          episode.attempt = attempt
          episode.error = settled.status.error
        }
      })

      // A defect or an interruption must not leave the registry entry behind: `startEpisode` refuses
      // to arm a second scheduler for a name, so a stale entry would silently end automatic
      // reconnection for that server. The ordinary exits still clear the entry themselves, so the
      // window in which an arm would be refused stays as short as possible; the identity check leaves
      // a replacement episode intact either way.
      const reconnectLoop = (name: ServerName, episode: ReconnectEpisode) =>
        retryServer(name, episode).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (episodes.get(name) === episode) episodes.delete(name)
            }),
          ),
        )

      const startEpisode = Effect.fnUntraced(function* (name: ServerName, error: string) {
        if (disposed || episodes.has(name)) return
        const episode: ReconnectEpisode = { attempt: 0, error }
        episodes.set(name, episode)
        episode.fiber = fork(reconnectLoop(name, episode))
      })

      const loadCatalog = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        recovering(name, entry, connection, (connection) =>
          Effect.all(
            {
              resources: connection.resources(),
              // Some servers declare resources without implementing template listing.
              templates: connection.resourceTemplates().pipe(Effect.orElseSucceed(() => [])),
            },
            { concurrency: "unbounded" },
          ),
        ).pipe(
          Effect.map((catalog) =>
            ResourceCatalog.make({
              resources: catalog.resources.map((resource) =>
                Resource.make({
                  server: name,
                  name: resource.name,
                  uri: resource.uri,
                  description: resource.description,
                  mimeType: resource.mimeType,
                }),
              ),
              templates: catalog.templates.map((template) =>
                ResourceTemplate.make({
                  server: name,
                  name: template.name,
                  uriTemplate: template.uriTemplate,
                  description: template.description,
                  mimeType: template.mimeType,
                }),
              ),
            }),
          ),
        )

      const watch = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) => {
        const live = whenLive(name, entry, connection)
        connection.onClose((reason) =>
          live(
            Effect.gen(function* () {
              entry.status = { status: "failed", error: reason }
              yield* stopServer(name, entry)
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
              // The transport is gone either way; a close is what the automatic reconnect picks up.
              yield* startEpisode(name, reason)
            }),
          ),
        )
        // Background refreshes (list-changed) can observe the expiry too; they do not retry, so
        // reconnect here for them. Foreground calls reconnect through `recovering`.
        connection.onSessionExpired(() => fork(recover(name, entry, connection)))
        connection.onToolsChanged(() =>
          live(
            refreshTools(name, entry, connection).pipe(
              Effect.andThen(bus.publish(McpEvent.ToolsChanged, { server: name })),
            ),
          ),
        )
        connection.onPromptsChanged(() => live(refreshPrompts(name, entry, connection)))
        connection.onResourcesChanged(() => live(bus.publish(McpEvent.ResourcesChanged, { server: name })))
      }

      const startServer = (name: ServerName, entry: ServerEntry) =>
        Effect.gen(function* () {
          // Announce the handshake so connect() and credential reconnects don't show a stale
          // disabled/failed status for the duration of the connection attempt. An automatic-retry
          // episode is the exception: the status keeps its retry hint there, because the hint is what
          // tells the user retries continue, and a flip to "pending" would also clear the TUI's
          // failure alert so every single attempt raised it again.
          if (!episodes.has(name)) {
            entry.status = { status: "pending" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
          }
          const scope = yield* Scope.fork(root)
          entry.scope = scope
          const authProvider = yield* connectProvider(entry)
          const { McpClient } = yield* Effect.promise(() => import("./client.js"))
          // List tools as part of connect so a failure here marks the server failed rather than
          // leaving it connected with a silently empty tool list and no path to recover.
          const load = McpClient.connect(
            name,
            entry.config,
            location.directory,
            authProvider,
            elicitation,
            options?.clientInfo,
          ).pipe(
            Effect.flatMap((connection) => connection.tools().pipe(Effect.map((tools) => ({ connection, tools })))),
            // A stdio server is spawned on this location's execution plane, not the host's.
            Effect.provideService(Environment.Service, environment),
            Scope.provide(scope),
          )
          const result = yield* (
            entry.config.type === "remote" ? endpointLoads.withLock(entry.config.url)(load) : load
          ).pipe(Effect.exit)
          if (Exit.isSuccess(result)) {
            entry.client = result.value.connection
            entry.tools = result.value.tools.map((tool) => toTool(name, entry, tool))
            entry.prompts = []
            entry.status = { status: "connected" }
            watch(name, entry, result.value.connection)
            yield* Effect.logInfo("mcp connected", { server: name, tools: entry.tools.length })
            // The tool registry reads on this event; a late-connecting server has no other way to appear.
            yield* bus.publish(McpEvent.ToolsChanged, { server: name })
            yield* bus.publish(McpEvent.ResourcesChanged, { server: name })
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
            whenLive(name, entry, result.value.connection)(refreshPrompts(name, entry, result.value.connection))
            yield* settleEpisode(name, result.value.connection)
            return
          }
          yield* Scope.close(scope, Exit.void)
          entry.scope = undefined
          const error = Cause.squash(result.cause)
          const status: Status =
            error instanceof McpClient.NeedsAuthError
              ? { status: "needs_auth", error: error.message }
              : { status: "failed", error: error instanceof Error ? error.message : String(error) }
          entry.status = status
          yield* Effect.logWarning("mcp connect failed", { server: name, status })
          yield* bus.publish(McpEvent.StatusChanged, { server: name })
          // A plain failure is what the automatic reconnect picks up; needs_auth waits for the user.
          if (status.status === "failed") yield* startEpisode(name, status.error)
        }).pipe(
          Effect.ensuring(entry.startup.open),
          Effect.annotateLogs({ server: name, directory: location.directory, connectionID: crypto.randomUUID() }),
        )

      const stopServer = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        const scope = entry.scope
        if (!scope) return
        entry.scope = undefined
        entry.client = undefined
        entry.tools = undefined
        entry.prompts = undefined
        yield* Scope.close(scope, Exit.void)
        yield* bus.publish(McpEvent.ToolsChanged, { server: name })
        yield* bus.publish(McpEvent.ResourcesChanged, { server: name })
        yield* bus.publish(PromptsChanged, { server: name })
      })

      const disposeServer = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        yield* stopServer(name, entry)
        if (entry.integrationID) owned.delete(entry.integrationID)
        if (entry.registration) yield* entry.registration.dispose
      })

      const replaceServer = Effect.fnUntraced(function* (name: ServerName, serverConfig: Mcp.ServerConfig) {
        yield* cancelEpisode(name)
        const previous = entries.get(name)
        if (previous) yield* disposeServer(name, previous)
        const entry: ServerEntry = {
          config: serverConfig,
          status: { status: "pending" },
          startup: Latch.makeUnsafe(),
        }
        entries.set(name, entry)
        yield* Effect.gen(function* () {
          yield* register(name, entry)
          if (serverConfig.disabled) {
            entry.status = { status: "disabled" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
            return
          }
          yield* startServer(name, entry)
        }).pipe(
          // Settle startup even when registration fails or replacement is interrupted, so readers cannot hang.
          Effect.ensuring(entry.startup.open),
        )
      })

      const removeServer = Effect.fnUntraced(function* (name: ServerName) {
        const entry = entries.get(name)
        if (!entry) return
        yield* cancelEpisode(name)
        yield* disposeServer(name, entry)
        // Credentials are keyed by name + URL and intentionally survive removal for a later re-add.
        entries.delete(name)
        yield* bus.publish(McpEvent.StatusChanged, { server: name })
      })

      let applied: Map<ServerName, Mcp.ServerConfig> | undefined
      const overrides = new Map<ServerName, Mcp.ServerConfig | false>()
      const reconcileLock = Semaphore.makeUnsafe(1)
      const reconcile = Effect.fnUntraced(function* () {
        const servers = state.get().servers
        if (!applied && entries.size === 0) {
          for (const [name, server] of servers) {
            entries.set(name, {
              config: server,
              status: { status: "pending" },
              startup: Latch.makeUnsafe(),
            })
          }
          yield* Effect.forEach(entries, ([name, entry]) => register(name, entry), { discard: true })
          applied = servers

          // Initial connections stay asynchronous so one slow server does not block Location startup.
          for (const [name, entry] of entries) {
            if (entry.config.disabled) {
              entry.status = { status: "disabled" }
              entry.startup.openUnsafe()
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
              continue
            }
            fork(startServer(name, entry).pipe(locks.withLock(name)))
          }
          return
        }

        const names = new Set([...(applied?.keys() ?? []), ...servers.keys()])
        for (const name of names) {
          const previous = applied?.get(name)
          const updated = servers.get(name)
          if (isDeepStrictEqual(previous, updated)) continue
          if (!updated) {
            yield* removeServer(name).pipe(locks.withLock(name))
            continue
          }
          yield* replaceServer(name, updated).pipe(locks.withLock(name))
        }
        applied = servers
      })

      // Bring a server online (or back to needs_auth) when its integration's credential changes, so an
      // OAuth login takes effect without a restart. Only fires for the integrations we registered.
      const reconnect = (integrationID: Integration.ID) =>
        Effect.gen(function* () {
          const match = Array.from(entries).find(([, entry]) => entry.integrationID === integrationID)
          if (!match) return
          const name = match[0]
          yield* Effect.gen(function* () {
            // add() or remove() may have replaced or deleted the entry while we waited for the lock.
            const entry = entries.get(name)
            if (!entry || entry.integrationID !== integrationID) return
            if (entry.status.status === "disabled") return
            yield* stopServer(name, entry)
            yield* startServer(name, entry)
          }).pipe(locks.withLock(name))
        })
      fork(
        bus.subscribe(Credential.Event.Switched).pipe(
          Stream.filter((event) => owned.has(event.data.integrationID)),
          Stream.runForEach((event) => Effect.sync(() => fork(reconnect(event.data.integrationID)))),
        ),
      )
      const state: State.Interface<Data, Editor> = State.create<Data, Editor>({
        name: "mcp",
        initial: () => ({
          servers: new Map(
            Array.from(overrides).flatMap(([name, config]) =>
              config === false ? [] : [[name, cloneConfig(config)] as const],
            ),
          ),
          removed: new Set(Array.from(overrides).flatMap(([name, config]) => (config === false ? [name] : []))),
        }),
        editor: (editor) => ({
          list: () => Array.from(editor.servers),
          get: (server) => editor.servers.get(ServerName.make(server)),
          set: (server, serverConfig) => {
            const name = ServerName.make(server)
            if (editor.removed.has(name)) return
            editor.servers.set(name, cloneConfig(serverConfig))
          },
          update: (server, update) => {
            const current = editor.servers.get(ServerName.make(server))
            if (!current) return
            update(current)
          },
          remove: (server) => editor.servers.delete(ServerName.make(server)),
        }),
        notify: () => State.reconcile(root, fork, () => reconcileLock.withPermit(reconcile())),
      })

      return Service.of({
        transform: state.transform,
        reload: state.reload,
        servers: Effect.fn("MCP.servers")(function* () {
          return Array.from(entries)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([name, entry]): ServerInfo => ({ name, status: entry.status, integrationID: entry.integrationID }))
        }),
        add: Effect.fn("MCP.add")(function* (server, config) {
          const name = ServerName.make(server)
          overrides.set(name, config)
          yield* state.reload()
        }),
        connect: Effect.fn("MCP.connect")(function* (server) {
          const name = ServerName.make(server)
          yield* Effect.gen(function* () {
            const target = yield* requireServer(name)
            yield* cancelEpisode(name)
            yield* stopServer(name, target.entry)
            yield* startServer(name, target.entry)
          }).pipe(locks.withLock(name))
        }),
        disconnect: Effect.fn("MCP.disconnect")(function* (server) {
          const name = ServerName.make(server)
          yield* Effect.gen(function* () {
            const target = yield* requireServer(name)
            yield* cancelEpisode(name)
            yield* stopServer(name, target.entry)
            target.entry.status = { status: "disabled" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
          }).pipe(locks.withLock(name))
        }),
        remove: Effect.fn("MCP.remove")(function* (server) {
          const name = ServerName.make(server)
          yield* requireServer(name)
          overrides.set(name, false)
          yield* state.reload()
        }),
        // Reads report what is connected now; servers still starting contribute once they publish a change.
        tools: Effect.fn("MCP.tools")(function* () {
          return Array.from(entries.values())
            .flatMap((entry) => entry.tools ?? [])
            .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        callTool: Effect.fn("MCP.callTool")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client)
            return yield* new ToolCallError({
              server: target.name,
              tool: input.name,
              message: unavailable(target.name, target.entry.status),
            })
          const result = yield* recovering(target.name, target.entry, target.entry.client, (connection) =>
            connection.callTool({ name: input.name, args: input.args, sessionID: input.sessionID }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ToolCallError({
                  server: target.name,
                  tool: input.name,
                  message: `MCP tool "${input.name}" on server "${target.name}" failed: ${error.message}`,
                }),
            ),
          )
          return { ...result, server: target.name, tool: input.name }
        }),
        instructions: Effect.fn("MCP.instructions")(function* () {
          return Array.from(entries)
            .flatMap(([server, entry]) => {
              const instructions = entry.client?.instructions
              if (!instructions) return []
              return [{ server, instructions }]
            })
            .toSorted((a, b) => a.server.localeCompare(b.server))
        }),
        prompts: Effect.fn("MCP.prompts")(function* () {
          return Array.from(entries.values())
            .flatMap((entry) => entry.prompts ?? [])
            .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        prompt: Effect.fn("MCP.prompt")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client) return undefined
          const result = yield* recovering(target.name, target.entry, target.entry.client, (connection) =>
            connection.prompt({ name: input.name, args: input.args }),
          ).pipe(Effect.orElseSucceed(() => undefined))
          if (!result) return undefined
          return { ...result, server: target.name, name: input.name }
        }),
        resourceCatalog: Effect.fn("MCP.resourceCatalog")(function* () {
          const empty = ResourceCatalog.make({ resources: [], templates: [] })
          const catalogs = yield* Effect.forEach(
            Array.from(entries),
            ([name, entry]) =>
              entry.client
                ? loadCatalog(name, entry, entry.client).pipe(Effect.orElseSucceed(() => empty))
                : Effect.succeed(empty),
            { concurrency: "unbounded" },
          )
          return mergeCatalogs(catalogs)
        }),
        resources: Effect.fn("MCP.resources")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client) return ResourceCatalog.make({ resources: [], templates: [] })
          return mergeCatalogs([yield* loadCatalog(target.name, target.entry, target.entry.client)])
        }),
        readResource: Effect.fn("MCP.readResource")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client) return undefined
          const result = yield* recovering(target.name, target.entry, target.entry.client, (connection) =>
            connection.readResource({ uri: input.uri }),
          )
          if (!result) return undefined
          return ResourceContent.make({
            server: target.name,
            uri: input.uri,
            contents: result.contents.map((part) =>
              "text" in part
                ? { type: "text", uri: part.uri, text: part.text, mimeType: part.mimeType }
                : { type: "blob", uri: part.uri, blob: part.blob, mimeType: part.mimeType },
            ),
          })
        }),
      })
    }),
  )

function mergeCatalogs(catalogs: ReadonlyArray<ResourceCatalog>) {
  return ResourceCatalog.make({
    resources: catalogs
      .flatMap((catalog) => catalog.resources)
      .toSorted(
        (a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri),
      ),
    templates: catalogs
      .flatMap((catalog) => catalog.templates)
      .toSorted(
        (a, b) =>
          a.server.localeCompare(b.server) ||
          a.name.localeCompare(b.name) ||
          a.uriTemplate.localeCompare(b.uriTemplate),
      ),
  })
}

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Location.node, Environment.node, Bus.node, Form.node, Integration.node, Credential.node],
  })
}

export const node = configured()

// Schema `optional` strips undefined-valued properties on encode, so fields can assign
// optional properties directly instead of conditionally spreading them.
function toElicitationField(key: string, property: ElicitationProperty, required: boolean): Form.Field {
  // Some servers emit machine titles like "string with format email"; prefer description/key over those.
  const machineTitle = /^(boolean|string|number|integer|array|object)(\s+with\b.*|\s+in\b.*)?$/i
  const title =
    property.title && !machineTitle.test(property.title.trim()) ? property.title : (property.description ?? key)
  const base = {
    key,
    title,
    description: property.description === title ? undefined : property.description,
    required: required || undefined,
  }
  switch (property.type) {
    case "boolean":
      return { ...base, type: "boolean", default: property.default }
    case "number":
    case "integer":
      return {
        ...base,
        type: property.type,
        minimum: property.minimum,
        maximum: property.maximum,
        default: property.default,
      }
    case "array":
      return {
        ...base,
        type: "multiselect",
        options:
          "anyOf" in property.items
            ? property.items.anyOf.map((option) => ({ value: option.const, label: option.title }))
            : property.items.enum.map((value) => ({ value, label: value })),
        custom: false,
        minItems: property.minItems,
        maxItems: property.maxItems,
        default: property.default,
      }
    case "string": {
      const options =
        "oneOf" in property
          ? property.oneOf.map((option) => ({ value: option.const, label: option.title }))
          : "enum" in property
            ? property.enum.map((value, index) => ({
                value,
                label: ("enumNames" in property ? property.enumNames?.[index] : undefined) ?? value,
              }))
            : undefined
      return {
        ...base,
        type: "string",
        format: "format" in property ? property.format : undefined,
        minLength: "minLength" in property ? property.minLength : undefined,
        maxLength: "maxLength" in property ? property.maxLength : undefined,
        default: property.default,
        options,
        custom: options ? false : undefined,
      }
    }
  }
}

type ElicitationProperty = McpClient.ElicitationFormParams["requestedSchema"]["properties"][string]
