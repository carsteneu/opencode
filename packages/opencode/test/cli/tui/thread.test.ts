import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { TuiThreadCommand, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
import { startTuiServerProcess } from "../../../src/cli/tui/process-server"
import { cliIt } from "../../lib/cli-process"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("starts the TUI server in a separate process", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
    const server = await Bun.file(new URL("../../../src/cli/tui/process-server.ts", import.meta.url)).text()

    expect(source).toContain("startTuiServerProcess")
    expect(source).not.toContain("new Worker")
    expect(server).not.toContain("InstanceRuntime")
    expect(server).not.toContain("AppRuntime")
  })

  test("starts and stops the private TUI server child", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await startTuiServerProcess({
      directory: tmp.path,
      network: { hostname: "127.0.0.1", port: 0 },
      private: true,
      entrypoint: path.resolve(import.meta.dir, "../../../src/bootstrap.ts"),
    })

    expect(await server.url).toStartWith("http://127.0.0.1:")
    expect(server.password).toBeString()
    expect(server.events).toBeDefined()
    if (!server.events) throw new Error("Private TUI server did not expose IPC events")
    const disposed = Promise.withResolvers<string>()
    const unsubscribe = await server.events.subscribe((event) => {
      if (event.payload.type === "global.disposed") disposed.resolve(event.payload.type)
    })
    const response = await fetch((await server.url) + "/global/health", {
      headers: { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` },
    })
    expect(response.status).toBe(200)
    const dispose = await fetch((await server.url) + "/global/dispose", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` },
    })
    expect(dispose.status).toBe(200)
    expect(
      await Promise.race([
        disposed.promise,
        Bun.sleep(5_000).then(() => {
          throw new Error("Timed out waiting for private TUI server IPC event")
        }),
      ]),
    ).toBe("global.disposed")
    unsubscribe()
    await server.stop()
  }, 20_000)

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})
