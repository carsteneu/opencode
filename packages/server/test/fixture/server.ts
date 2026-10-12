import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { ServerProcess } from "../../src/process"

export const startServer = Effect.fnUntraced(function* (directory: string, config?: { global?: boolean }) {
  const server = yield* ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: ":memory:" },
    config: { directory, ...config },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return {
    base: HttpServer.formatAddress(server.address),
    headers: { authorization: `Basic ${btoa("opencode:secret")}` },
  }
})
