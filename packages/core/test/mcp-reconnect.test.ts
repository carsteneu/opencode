import path from "node:path"
import { expect } from "bun:test"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { ID, type Payload } from "@opencode/schema/event"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Form } from "@opencode/core/form"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { AbsolutePath } from "@opencode/core/schema"
import { State } from "@opencode/core/state"
import { Context, Effect, Exit, Layer, Schedule, Scope, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { it } from "./lib/effect"
import { hostEnvironmentLayer } from "./fixture/environment"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"

const fixture = path.join(import.meta.dir, "fixture/mcp-reconnect-stdio.ts")

// The production schedule waits minutes between attempts; an episode with these bands and a pinned
// jitter runs in milliseconds, so a test observes real retries instead of simulating a clock.
const reconnect: Mcp.Reconnect = { bands: [250, 60], bandSize: 1, maxAttempts: 100, jitter: () => 1 }

const local = (environment: Record<string, string>) =>
  new ConfigMCP.Local({ type: "local", command: [process.execPath, fixture], environment })

const unusedIntegration = () => Effect.die("unused integration service")

function reconnectLayer(options?: Mcp.Reconnect) {
  return Mcp.layer({ reconnect: options }).pipe(
    Layer.provideMerge(Form.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
        ),
        Layer.mock(Bus.Service, {
          subscribe: () => Stream.never,
          publish: (definition, data) =>
            Effect.succeed({ id: ID.create(), type: definition.type, data } as Payload<typeof definition>),
        }),
        Layer.mock(Integration.Service, {
          revision: () => 0,
          connection: {
            active: unusedIntegration,
            resolve: unusedIntegration,
            key: unusedIntegration,
            external: unusedIntegration,
            activate: unusedIntegration,
            update: unusedIntegration,
            remove: unusedIntegration,
            status: unusedIntegration,
          },
          oauth: {
            connect: unusedIntegration,
            status: unusedIntegration,
            complete: unusedIntegration,
            cancel: unusedIntegration,
          },
          command: {
            connect: unusedIntegration,
            status: unusedIntegration,
            cancel: unusedIntegration,
          },
        }),
        Layer.mock(Credential.Service, {}),
        hostEnvironmentLayer,
      ),
    ),
  )
}

// The retry hint is the only surface that says "this server is still being retried"; the sidebar
// and the `/mcps` dialog read the same field.
const retrying = (status: Mcp.Status) => status.status === "failed" && /retry \d+\/\d+ in/.test(status.error)

const attempt = (status: Mcp.Status | undefined) =>
  status?.status === "failed" ? Number(/retry (\d+)\//.exec(status.error)?.[1]) : Number.NaN

const failure = (status: Mcp.Status | undefined) => (status?.status === "failed" ? status.error : "")

// Reads the same surface the sidebar renders, so recovery is observed the way a user would see it.
const until = (mcp: Mcp.Interface, name: string, predicate: (status: Mcp.Status) => boolean) =>
  Effect.gen(function* () {
    const found = (yield* mcp.servers()).find((server) => server.name === name)
    if (found && predicate(found.status)) return found.status
    return yield* Effect.fail(found?.status ?? { status: "disabled" as const })
  }).pipe(Effect.retry({ times: 2_000, schedule: Schedule.spaced("10 millis") }))

// Records the sequence of distinct status labels, so a server that keeps flapping shows up as
// repeated episodes rather than as one long-lived status.
const trace = (mcp: Mcp.Interface, name: string, stop: (labels: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function* () {
    const labels: string[] = []
    for (let step = 0; step < 3_000; step++) {
      const found = (yield* mcp.servers()).find((server) => server.name === name)
      const label = found === undefined ? "absent" : retrying(found.status) ? "retrying" : found.status.status
      if (label !== labels[labels.length - 1]) labels.push(label)
      if (stop(labels)) return labels
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error(`timed out tracing the status of ${name}`))
  })

const toolNames = (mcp: Mcp.Interface) => Effect.map(mcp.tools(), (tools) => tools.map((tool) => tool.name))

const kill = (pidFile: string) =>
  Effect.promise(() => Bun.file(pidFile).text()).pipe(
    Effect.flatMap((pid) => Effect.sync(() => process.kill(Number(pid), "SIGKILL"))),
  )

const read = (file: string) => Effect.promise(() => Bun.file(file).text())

// Signal 0 only asks whether a pid can still be signalled, which is how a test tells a respawn from
// a process that is really gone.
const alive = (pid: string) =>
  Effect.try({ try: () => process.kill(Number(pid), 0), catch: (cause) => cause }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

it.live(
  "reconnects on its own after the server process is killed",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const mcp = yield* Mcp.Service
        yield* mcp.add("killed", local({ MCP_RECONNECT_PID_FILE: pidFile }))

        yield* until(mcp, "killed", (status) => status.status === "connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])

        yield* kill(pidFile)

        const failed = yield* until(mcp, "killed", retrying)
        expect(failure(failed)).toMatch(/ — retry 1\/100 in 0s$/)

        const reconnected = yield* until(mcp, "killed", (status) => status.status === "connected")
        expect(reconnected.status).toBe("connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)

it.live(
  "arms a replacement episode when the server flaps right after listing tools",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const mcp = yield* Mcp.Service
        yield* mcp.add(
          "flapping",
          local({ MCP_RECONNECT_PID_FILE: pidFile, MCP_RECONNECT_EXIT_AFTER_LIST: "40" }),
        )

        // Each close has to arm a fresh episode. An episode that ended on its own connect must not
        // clear the replacement that the close already created.
        const labels = yield* trace(mcp, "flapping", (seen) => seen.filter((label) => label === "retrying").length >= 2)
        expect(labels.filter((label) => label === "retrying").length).toBeGreaterThanOrEqual(2)
        expect(labels).toContain("connected")

        // A server that stays up proves the retries were still alive.
        yield* mcp.add("flapping", local({ MCP_RECONNECT_PID_FILE: pidFile }))
        yield* until(mcp, "flapping", (status) => status.status === "connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)

it.live(
  "connects with a config corrected while an episode is running",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const marker = path.join(tmp.path, "available")
        const mcp = yield* Mcp.Service
        yield* mcp.add("corrected", local({ MCP_RECONNECT_PID_FILE: pidFile, MCP_RECONNECT_MARKER: marker }))

        const failed = yield* until(mcp, "corrected", retrying)
        expect(failure(failed)).toMatch(/exited with code 1/)

        // Correcting the server config while the episode runs must take effect without a manual
        // connect: the corrected config is what the retry connects with.
        yield* mcp.add("corrected", local({ MCP_RECONNECT_PID_FILE: pidFile }))

        yield* until(mcp, "corrected", (status) => status.status === "connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)

it.live(
  "applies a configuration corrected mid-episode from inside its own episode",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const marker = path.join(tmp.path, "available")
        const mcp = yield* Mcp.Service
        yield* mcp.add("self-corrected", local({ MCP_RECONNECT_PID_FILE: pidFile, MCP_RECONNECT_MARKER: marker }))
        yield* until(mcp, "self-corrected", retrying)

        // A State transform invalidates the resolved configuration without notifying, so during this
        // batch nothing but the running episode can apply the correction: its next attempt has to
        // replace the very server it is retrying, from inside its own fiber. Interrupting that fiber
        // the way a plain cancel would would deadlock it, so the episode would never connect here.
        yield* State.batch(
          Effect.gen(function* () {
            yield* mcp.transform((editor) => {
              editor.update("self-corrected", (config) => {
                if (config.type === "local") config.environment = { MCP_RECONNECT_PID_FILE: pidFile }
              })
            })
            yield* until(mcp, "self-corrected", (status) => status.status === "connected")
          }),
        )

        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  45_000,
)

it.live(
  "ends the episode when the server is disconnected",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const mcp = yield* Mcp.Service
        yield* mcp.add(
          "cancelled",
          local({ MCP_RECONNECT_PID_FILE: path.join(tmp.path, "server.pid"), MCP_RECONNECT_MARKER: path.join(tmp.path, "available") }),
        )
        yield* until(mcp, "cancelled", retrying)

        yield* mcp.disconnect("cancelled")
        // Several bands pass here: an episode that survived would write its hint back.
        yield* Effect.sleep("600 millis")
        const found = (yield* mcp.servers()).find((server) => server.name === "cancelled")
        expect(found?.status.status).toBe("disabled")
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)

it.live(
  "keeps its episode across a reload with an unchanged configuration",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const marker = path.join(tmp.path, "available")
        const mcp = yield* Mcp.Service
        yield* mcp.add("reloaded", local({ MCP_RECONNECT_PID_FILE: pidFile, MCP_RECONNECT_MARKER: marker }))
        yield* until(mcp, "reloaded", retrying)

        // Re-resolving an unchanged configuration is not a config change: it must neither cancel the
        // episode nor arm a second one, and the server still has to come up on its own.
        yield* mcp.reload()
        const kept = yield* until(mcp, "reloaded", retrying)
        expect(failure(kept)).toMatch(/retry \d+\/100 in/)

        yield* Effect.promise(() => Bun.write(marker, "yes"))
        yield* until(mcp, "reloaded", (status) => status.status === "connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)

it.live(
  "gives up after the configured attempts with the original error and without the retry hint",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const marker = path.join(tmp.path, "available")
        const mcp = yield* Mcp.Service
        yield* mcp.add("abandoned", local({ MCP_RECONNECT_MARKER: marker }))

        const hinted = yield* until(mcp, "abandoned", retrying)
        expect(attempt(hinted)).toBeGreaterThanOrEqual(1)

        const abandoned = yield* until(mcp, "abandoned", (status) => status.status === "failed" && !retrying(status))
        expect(failure(abandoned)).toMatch(/exited with code 1/)
        expect(failure(abandoned)).not.toMatch(/retry/)

        const logs = yield* TestConsole.logLines
        expect(logs.some((line) => JSON.stringify(line).includes("MCP reconnect abandoned"))).toBe(true)

        // Recovery needs no restart: the user reconnects the fixed server from /mcps.
        yield* Effect.promise(() => Bun.write(marker, "yes"))
        yield* mcp.connect("abandoned")
        yield* until(mcp, "abandoned", (status) => status.status === "connected")
        expect(yield* toolNames(mcp)).toEqual(["current_directory"])
      }).pipe(
        Effect.provide(reconnectLayer({ ...reconnect, maxAttempts: 3 })),
      ),
    ),
  30_000,
)

it.live(
  "stops retrying when the layer is disposed",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const root = yield* Scope.make()
        // Long first band so the episode cannot respawn before the disposal under test.
        const context = yield* Layer.buildWithScope(reconnectLayer({ ...reconnect, bands: [2_000, 60] }), root)
        const mcp = Context.get(context, Mcp.Service)

        yield* mcp.add("disposed", local({ MCP_RECONNECT_PID_FILE: pidFile }))
        yield* until(mcp, "disposed", (status) => status.status === "connected")

        yield* kill(pidFile)
        yield* until(mcp, "disposed", retrying)
        const crashed = (yield* read(pidFile)).trim()

        // Disposal must end the episode: a scheduler that survives keeps respawning the server.
        yield* Scope.close(root, Exit.void)
        yield* Effect.sleep("1 second")

        expect((yield* read(pidFile)).trim()).toBe(crashed)
        expect(yield* alive(crashed)).toBe(false)
        const found = (yield* mcp.servers()).find((server) => server.name === "disposed")
        expect(found?.status.status).not.toBe("connected")
      }),
    ),
  30_000,
)

it.live(
  "resets the attempt counter after a successful connect",
  () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const pidFile = path.join(tmp.path, "server.pid")
        const marker = path.join(tmp.path, "available")
        const mcp = yield* Mcp.Service
        yield* mcp.add("counter", local({ MCP_RECONNECT_PID_FILE: pidFile, MCP_RECONNECT_MARKER: marker }))

        const climbing = yield* until(mcp, "counter", (status) => attempt(status) >= 2)
        expect(attempt(climbing)).toBeGreaterThanOrEqual(2)

        yield* Effect.promise(() => Bun.write(marker, "yes"))
        yield* until(mcp, "counter", (status) => status.status === "connected")

        // A close after a successful connect starts a new episode at attempt one.
        yield* kill(pidFile)
        const restarted = yield* until(mcp, "counter", retrying)
        expect(attempt(restarted)).toBe(1)
      }).pipe(Effect.provide(reconnectLayer(reconnect))),
    ),
  30_000,
)
