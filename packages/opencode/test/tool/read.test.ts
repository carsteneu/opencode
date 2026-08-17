import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { open } from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Stream } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(test.directory, "large.json"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("stops streaming after the requested line page", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "many-lines.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath, limit: 10 }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10")
      expect(result.metadata.display).not.toHaveProperty("totalLines")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("preserves UTF-8 and CRLF across small stream chunks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "chunked.txt")
      yield* put(filepath, "ä\r\n🙂\r\nlast")

      const fs = yield* FSUtil.Service
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs
                .stream(file, options)
                .pipe(Stream.flatMap((chunk) => Stream.fromIterable(Array.from(chunk, (byte) => Uint8Array.of(byte))))),
          }),
        ),
      )

      expect(result.output).toContain("1: ä\n2: 🙂\n3: last")
      expect(result.output).toContain("End of file - total 3 lines")
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.instance("keeps empty and text files off the media stat and full-read path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      for (const item of [
        { name: "empty.txt", content: "", output: "End of file - total 0 lines" },
        { name: "small.txt", content: "hello world", output: "1: hello world" },
      ]) {
        const filepath = path.join(test.directory, item.name)
        yield* put(filepath, item.content)
        const result = yield* run({ filePath: filepath }).pipe(
          Effect.provideService(
            FSUtil.Service,
            FSUtil.Service.of({
              ...fs,
              readFile: () => Effect.die("text must not use the media full-read path"),
              open: (file, options) =>
                Effect.gen(function* () {
                  const handle = yield* fs.open(file, options)
                  return new Proxy(handle, {
                    get(target, property, receiver) {
                      if (property === "stat") return Effect.die("text must not use media handle stat")
                      return Reflect.get(target, property, receiver)
                    },
                  })
                }),
            }),
          ),
        )

        expect(result.output).toContain(item.output)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeUndefined()
      }
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
      expect(result.attachments?.[0]).toEqual({
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${png.toString("base64")}`,
      })
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`)
    }),
  )

  it.live("preserves image and PDF bytes across short handle reads without a pathname reread", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const cases = [
        {
          name: "image.bin",
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
          mime: "image/png",
          output: "Image read successfully",
        },
        {
          name: "report.bin",
          bytes: Buffer.from("%PDF-1.7\nbody\n%%EOF"),
          mime: "application/pdf",
          output: "PDF read successfully",
        },
      ] as const

      for (const item of cases) {
        const filepath = path.join(dir, item.name)
        const opens = { count: 0 }
        yield* put(filepath, item.bytes)
        const result = yield* exec(dir, { filePath: filepath }).pipe(
          Effect.provideService(
            FSUtil.Service,
            FSUtil.Service.of({
              ...fs,
              readFile: () => Effect.die("media must stay on its scoped handle"),
              open: (file, options) =>
                Effect.gen(function* () {
                  opens.count++
                  const handle = yield* fs.open(file, options)
                  return new Proxy(handle, {
                    get(target, property, receiver) {
                      if (property !== "readAlloc") return Reflect.get(target, property, receiver)
                      return (size: Parameters<typeof handle.readAlloc>[0]) =>
                        handle.readAlloc(Math.min(Number(size), 2))
                    },
                  })
                }),
            }),
          ),
        )

        expect(result.output).toBe(item.output)
        expect(result.metadata.truncated).toBe(false)
        expect(opens.count).toBe(1)
        expect(result.attachments).toEqual([
          {
            type: "file",
            mime: item.mime,
            url: `data:${item.mime};base64,${item.bytes.toString("base64")}`,
          },
        ])
      }
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("accepts media at the exact ingestion limit without losing bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "limit.png")
      const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(async () => {
        const file = await open(filepath, "w")
        await file.write(header)
        await file.truncate(MAX_MEDIA_BYTES)
        await file.close()
      })

      const result = yield* exec(dir, { filePath: filepath })
      const attachment = result.attachments?.[0]
      if (!attachment) return yield* Effect.die("missing exact-limit media attachment")
      const bytes = Buffer.from(attachment.url.slice(`data:${attachment.mime};base64,`.length), "base64")
      expect(result.output).toBe("Image read successfully")
      expect(result.metadata.truncated).toBe(false)
      expect(attachment.mime).toBe("image/png")
      expect(bytes.length).toBe(MAX_MEDIA_BYTES)
      expect(bytes.subarray(0, header.length)).toEqual(header)
      expect(bytes.at(-1)).toBe(0)
    }),
  )

  it.live("rejects oversized media before loading it into memory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "oversized.png")
      yield* Effect.promise(async () => {
        const file = await open(filepath, "w")
        await file.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        await file.truncate(MAX_MEDIA_BYTES + 1)
        await file.close()
      })

      const error = yield* fail(dir, { filePath: filepath })
      expect(error.message).toBe(`Media exceeds ${MAX_MEDIA_BYTES} byte ingestion limit: ${filepath}`)
    }),
  )

  it.live("rejects media that grows beyond the limit after its sample is read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "growing.png")
      const initial = Buffer.alloc(8192)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(initial)
      yield* put(filepath, initial)

      const fs = yield* FSUtil.Service
      const reads = { count: 0 }
      const error = yield* fail(dir, { filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            open: (file, options) =>
              Effect.gen(function* () {
                const handle = yield* fs.open(file, options)
                return new Proxy(handle, {
                  get(target, property, receiver) {
                    if (property !== "readAlloc") return Reflect.get(target, property, receiver)
                    return (size: Parameters<typeof handle.readAlloc>[0]) =>
                      Effect.gen(function* () {
                        reads.count++
                        if (reads.count === 2) yield* fs.truncate(filepath, MAX_MEDIA_BYTES + 1)
                        return yield* handle.readAlloc(size)
                      })
                  },
                })
              }),
          }),
        ),
      )

      expect(reads.count).toBeGreaterThan(2)
      expect(error.message).toBe(`Media exceeds ${MAX_MEDIA_BYTES} byte ingestion limit: ${filepath}`)
    }),
  )

  it.live("closes the media handle when a read is interrupted", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "interrupted.png")
      const initial = Buffer.alloc(8192)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(initial)
      yield* put(filepath, initial)

      const fs = yield* FSUtil.Service
      const waiting = yield* Deferred.make<void>()
      const captured = { file: undefined as FileSystem.File | undefined }
      const reads = { count: 0 }
      const fiber = yield* exec(dir, { filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            open: (file, options) =>
              Effect.gen(function* () {
                const handle = yield* fs.open(file, options)
                captured.file = handle
                return new Proxy(handle, {
                  get(target, property, receiver) {
                    if (property !== "readAlloc") return Reflect.get(target, property, receiver)
                    return (size: Parameters<typeof handle.readAlloc>[0]) => {
                      reads.count++
                      if (reads.count === 1) return handle.readAlloc(size)
                      return Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
                    }
                  },
                })
              }),
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(waiting)
      yield* Fiber.interrupt(fiber)

      if (!captured.file) return yield* Effect.die("missing interrupted media handle")
      expect(Exit.isFailure(yield* captured.file.readAlloc(1).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})
