import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { expect, spyOn, test } from "bun:test"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

declare const OPENCODE_UPDATE_CHANNEL: string | undefined

const forkRun = typeof OPENCODE_UPDATE_CHANNEL === "string" && OPENCODE_UPDATE_CHANNEL === "v2patched"
const it = testEffect(NodeServices.layer)

const BINARY = "opencode-v2-linux-x64"
const CHECKSUM = `${BINARY}.sha256`
const REPOSITORY = "carsteneu/opencode"
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`
const BINARY_URL = `https://github.com/${REPOSITORY}/releases/download/2.0.26-v2patched.2/${BINARY}`
const CHECKSUM_URL = `${BINARY_URL}.sha256`
const PAYLOAD = "v2 fork release payload\n"
const BYTES = Buffer.from(PAYLOAD)
const HASH = new Bun.CryptoHasher("sha256").update(BYTES).digest("hex")

function releases(
  fork: Array<{ tag: string; assets: boolean }> = [
    { tag: "2.0.26-v2patched.2", assets: true },
    { tag: "2.0.26-v2patched.1", assets: true },
  ],
) {
  return [
    {
      tag_name: "1.18.34-patched.220",
      draft: false,
      prerelease: true,
      assets: [
        { name: "opencode-linux-x64", browser_download_url: "https://example.invalid/v1/bin" },
        { name: "opencode-linux-x64.sha256", browser_download_url: "https://example.invalid/v1/bin.sha256" },
      ],
    },
    {
      tag_name: "2.0.27",
      draft: false,
      prerelease: false,
      assets: [
        { name: BINARY, browser_download_url: "https://example.invalid/stable/bin" },
        { name: CHECKSUM, browser_download_url: "https://example.invalid/stable/bin.sha256" },
      ],
    },
    ...fork.map((item) => ({
      tag_name: item.tag,
      draft: false,
      prerelease: true,
      assets: item.assets
        ? [
            { name: BINARY, browser_download_url: BINARY_URL },
            { name: CHECKSUM, browser_download_url: CHECKSUM_URL },
          ]
        : [],
    })),
  ]
}

function fixture(
  input: {
    releases?: unknown
    checksum?: string
    reported?: string
  } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-fork-" })
    const execPath = process.execPath
    const executable = path.join(root, "node_modules", "@opencode", "cli", "bin", "opencode")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "binary")

    const requests: string[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (request: string | URL | Request) => {
              const url = request instanceof Request ? request.url : request.toString()
              requests.push(url)
              if (url === RELEASES_URL) return Response.json(input.releases ?? releases())
              if (url === CHECKSUM_URL)
                return new Response(input.checksum ?? `${HASH}  ${BINARY}\n`, {
                  headers: { "content-type": "text/plain" },
                })
              if (url === BINARY_URL)
                return new Response(new Uint8Array(BYTES), { headers: { "content-type": "application/octet-stream" } })
              return new Response("not found", { status: 404 })
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
      (request) => Effect.sync(() => request.mockRestore()),
    )

    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })

    const commands: string[][] = []
    const updater = yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (input) => (input === execPath ? Effect.succeed(executable) : fs.realPath(input)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command) =>
            Effect.suspend(() => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected piped install command")
              commands.push([command.command, ...command.args])
              const reported = input.reported ?? "2.0.26-v2patched.2"
              const stdout = command.args.includes("--version") ? Buffer.from(`opencode v${reported}\n`) : Buffer.alloc(0)
              return Effect.succeed({
                command: command.command,
                exitCode: 0,
                stdout,
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              })
            }),
          runStream: () => Stream.die("Unexpected streaming install command"),
        }),
      ),
    )
    const leftovers = () => readdirSync(path.dirname(executable)).filter((name) => name.includes(".update-"))
    return { updater, commands, requests, executable, leftovers }
  })
}

if (forkRun) {
  it.live("fork: resolves the newest fork prerelease instead of the official channel", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      expect(yield* test.updater.latest()).toBe("2.0.26-v2patched.2")
      expect(yield* test.updater.method()).toBe("curl")
      expect(test.requests).toEqual([RELEASES_URL])
    }),
  )

  it.live("fork: ignores releases that are not fork prereleases or lack both assets", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        releases: releases([
          { tag: "2.0.26-v2patched.9", assets: true },
          { tag: "2.0.26-v2patched.4", assets: false },
          { tag: "2.0.26-v2patched.3", assets: true },
        ]),
      })
      expect(yield* test.updater.latest()).toBe("2.0.26-v2patched.9")
      expect(test.requests).toEqual([RELEASES_URL])
    }),
  )

  it.live("fork: verifies the published checksum and swaps in the fork binary", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.updater.upgrade("curl", "2.0.26-v2patched.2")
      expect(readFileSync(test.executable, "utf8")).toBe(PAYLOAD)
      expect(statSync(test.executable).mode & 0o777).toBe(0o755)
      // The only command is the smoke test on the downloaded image.
      expect(test.commands).toHaveLength(1)
      expect(test.commands[0][0]).toStartWith(test.executable)
      expect(test.commands[0].slice(1)).toEqual(["--version"])
      expect(test.leftovers()).toEqual([])
      expect(test.requests).toEqual([RELEASES_URL, CHECKSUM_URL, BINARY_URL])
    }),
  )

  it.live("fork: refuses to replace the binary when the checksum does not match", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ checksum: `${"0".repeat(64)}  ${BINARY}\n` })
      const error = yield* test.updater.upgrade("curl", "2.0.26-v2patched.2").pipe(Effect.flip)
      expect(error.message).toContain(`Expected ${"0".repeat(64)}`)
      expect(readFileSync(test.executable, "utf8")).toBe("binary")
      expect(test.commands).toEqual([])
      expect(test.leftovers()).toEqual([])
    }),
  )

  it.live("fork: refuses to replace the binary when the image reports the wrong version", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ reported: "2.0.26-v2patched.9" })
      const error = yield* test.updater.upgrade("curl", "2.0.26-v2patched.2").pipe(Effect.flip)
      expect(error.message).toContain('reported "opencode v2.0.26-v2patched.9" instead of 2.0.26-v2patched.2')
      expect(readFileSync(test.executable, "utf8")).toBe("binary")
      expect(test.leftovers()).toEqual([])
    }),
  )

  it.live("fork: refuses an official release target without touching an installer", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const error = yield* test.updater.upgrade("curl", "2.0.27").pipe(Effect.flip)
      expect(error.message).toContain("only upgrades to v2patched prereleases")
      expect(error.message).toContain("2.0.27")
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
      expect(readFileSync(test.executable, "utf8")).toBe("binary")
    }),
  )

  it.live("fork: refuses a v1 patched target", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const error = yield* test.updater.upgrade("curl", "1.18.34-patched.220").pipe(Effect.flip)
      expect(error.message).toContain("only upgrades to v2patched prereleases")
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
    }),
  )

  it.live("fork: refuses a target that cannot move forward instead of reporting success", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const error = yield* test.updater.upgrade("curl", "2.0.26-v2patched.1").pipe(Effect.flip)
      expect(error.message).toContain("already at or above 2.0.26-v2patched.1")
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
      expect(readFileSync(test.executable, "utf8")).toBe("binary")
    }),
  )
}

// The fork channel is compiled in, so the checks above need a nested run with the
// same defines the fork build sets.
test("the fork channel resolves, verifies and refuses non-fork targets", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      import.meta.path,
      "--define",
      'OPENCODE_VERSION="2.0.26-v2patched.1"',
      "--define",
      'OPENCODE_CHANNEL="latest"',
      "--define",
      'OPENCODE_UPDATE_CHANNEL="v2patched"',
      "--define",
      'OPENCODE_UPDATE_REPOSITORY="carsteneu/opencode"',
      "--test-name-pattern",
      "^fork:",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
      // Bun 1.4 can reuse cached modules compiled with different --define values.
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  expect(stderr).toContain("8 pass")
})
