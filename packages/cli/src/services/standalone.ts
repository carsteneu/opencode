import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createWriteStream, mkdirSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { selfCommand } from "../util/process"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

type Options = {
  readonly command?: ReadonlyArray<string>
}

const startupDirectory = process.cwd()
const printLogs = () => process.env.OPENCODE_PRINT_LOGS === "1"

// A detached server's diagnostics must not be lost when its stderr is not the
// TUI's terminal (v1 cli/tui/process-server.ts: serverStderrSink).
function serverStderrSink() {
  const dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "log")
  // The log directory may not exist yet on first boot.
  mkdirSync(dir, { recursive: true })
  return createWriteStream(join(dir, "standalone-server.log"), { flags: "a" })
}

function command(password: string, options: Options) {
  const [executable, ...args] = options.command ?? [...selfCommand(), "serve"]
  if (!executable) throw new Error("Failed to resolve standalone server command")
  return ChildProcess.make(executable, [...args, "--stdio", "--port", "0"], {
    cwd: startupDirectory,
    // Explicit entry wins over anything inherited, so a user-exported
    // OPENCODE_PASSWORD cannot shadow the child's lease credential.
    env: { OPENCODE_PASSWORD: password },
    extendEnv: true,
    // The server treats EOF on this pipe as the end of its ownership lease.
    // The OS closes it even when the TUI is killed before Effect finalizers run.
    stdin: "pipe",
    stderr: printLogs() ? "inherit" : "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  })
}

const makeEndpoint = Effect.fn("cli.standalone.endpoint")(
  function* (options: Options) {
    const password = randomBytes(32).toString("base64url")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(command(password, options))
    if (!printLogs())
      yield* Effect.gen(function* () {
        const log = yield* Effect.sync(() => serverStderrSink())
        yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Effect.sync(() => log.write(chunk))),
          Effect.ensuring(Effect.sync(() => log.end())),
          Effect.forkScoped,
        )
      })
    const readyLine = yield* Deferred.make<string, Error>()
    // Keep draining stdout after readiness so later server writes cannot hit EPIPE.
    yield* proc.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
      Effect.ensuring(Deferred.fail(readyLine, new Error("Standalone server exited before reporting readiness"))),
      Effect.forkScoped,
    )
    const output = yield* Deferred.await(readyLine)
    const ready = yield* Effect.tryPromise(() => decodeReady(output))
    return {
      url: ready.url,
      auth: { type: "basic" as const, username: "opencode", password },
      pid: proc.pid,
      exited: proc.exitCode,
    }
  },
  Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
)

export function start(options: Options = {}) {
  return makeEndpoint(options)
}

export * as Standalone from "./standalone"
