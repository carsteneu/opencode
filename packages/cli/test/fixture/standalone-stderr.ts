import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Standalone } from "../../src/services/standalone"

// A fake server prints a marker on stderr before reporting readiness, so the
// sidecar log capture can be asserted without a real server boot.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Standalone.start({
        command: [
          process.execPath,
          "-e",
          `console.error("SIDECAR_MARKER"); console.log(JSON.stringify({ url: "http://127.0.0.1:1" })); setInterval(() => {}, 1000)`,
        ],
      })
      yield* Effect.sleep("500 millis")
      const file = path.join(
        process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
        "opencode",
        "log",
        "standalone-server.log",
      )
      const content = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))
      console.log(`SIDECAR_LOG ${file} ${JSON.stringify(content)}`)
    }),
  ),
)
