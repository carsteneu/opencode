import { afterEach, expect } from "bun:test"
import { $ } from "bun"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { StructuredFileDiff } from "@opencode-ai/core/tool/structured-file-diff"
import { Hash } from "@opencode-ai/core/util/hash"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { InstanceState } from "@/effect/instance-state"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)
// Windows forbids both * and : in directory names.
const nonWindowsIt = process.platform === "win32" ? it.live.skip : it.live
const nonWindowsInstanceIt = process.platform === "win32" ? it.instance.skip : it.instance

// Git always outputs /-separated paths internally. Snapshot.patch() joins them
// with path.join (which produces \ on Windows) then normalizes back to /.
// This helper does the same for expected values so assertions match cross-platform.
const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")
const SNAPSHOT_BATCH_BOUNDARY = 100
const OVER_BATCH_COUNT = SNAPSHOT_BATCH_BOUNDARY + 1
const MIXED_BATCH_GROUP_COUNT = Math.ceil(OVER_BATCH_COUNT / 4)

afterEach(async () => {
  await disposeAllInstances()
})

const exec = (cwd: string, command: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" })
    const code = await proc.exited
    if (code !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  })

const write = (file: string, content: string | Uint8Array) =>
  FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const readText = (file: string) => FSUtil.Service.use((fs) => fs.readFileString(file))
const exists = (file: string) => FSUtil.Service.use((fs) => fs.existsSafe(file))
const mkdirp = (dir: string) => FSUtil.Service.use((fs) => fs.ensureDir(dir))
const rm = (file: string) =>
  FSUtil.Service.use((fs) => fs.remove(file, { recursive: true, force: true }).pipe(Effect.ignore))

const initialize = Effect.fn("SnapshotTest.initialize")(function* (dir: string) {
  const unique = Math.random().toString(36).slice(2)
  const aContent = `A${unique}`
  const bContent = `B${unique}`
  yield* write(`${dir}/a.txt`, aContent)
  yield* write(`${dir}/b.txt`, bContent)
  return { aContent, bContent }
})

type Bootstrapped = { path: string; extra: { aContent: string; bContent: string } }

const bootstrap = Effect.fn("SnapshotTest.bootstrap")(function* () {
  const tmp = yield* TestInstance
  return { path: tmp.directory, extra: yield* initialize(tmp.directory) }
})

const withTrackedSnapshot = <A, E, R>(
  fn: (input: { tmp: Bootstrapped; snapshot: Snapshot.Interface; before: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    return yield* fn({ tmp, snapshot, before: before! })
  })

const bootstrapScoped = Effect.fn("SnapshotTest.bootstrapScoped")(function* () {
  const dir = yield* tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
  return { path: dir, extra: yield* initialize(dir) }
})

const scopedGitTmpdir = () =>
  tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))

const scopedTmpdir = () => tmpdirScoped().pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))

const cleanupWorktree = (repo: string, worktree: string, files: string[] = []) =>
  Effect.promise(async () => {
    await $`git worktree remove --force ${worktree}`.cwd(repo).quiet().nothrow()
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined)
    await Promise.all(files.map((file) => fs.rm(file, { recursive: true, force: true }).catch(() => undefined)))
  })

const withProcessEnvironment = <A, E, R>(values: Record<string, string>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]] as const))),
    () =>
      Effect.sync(() => {
        Object.entries(values).forEach(([key, value]) => {
          process.env[key] = value
        })
      }).pipe(Effect.andThen(self)),
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )

const withGitConfigGlobal = <A, E, R>(config: string, self: Effect.Effect<A, E, R>) =>
  withProcessEnvironment({ GIT_CONFIG_GLOBAL: config }, self)

const makeGitWrapper = Effect.fn("SnapshotTest.makeGitWrapper")(function* (dir: string) {
  const git = Bun.which("git")
  if (!git) return yield* Effect.die("git is required")
  const wrapperDir = path.join(dir, "git-wrapper")
  const wrapper = path.join(wrapperDir, "git")
  const log = path.join(wrapperDir, "commands.jsonl")
  const pid = path.join(wrapperDir, "pid")
  yield* mkdirp(wrapperDir)
  yield* write(
    wrapper,
    `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"

const args = Bun.argv.slice(2)
const log = Bun.env.OPENCODE_SNAPSHOT_GIT_LOG
if (log) await appendFile(log, JSON.stringify(args) + "\\n")

const catFile = args.indexOf("cat-file")
const option = catFile < 0 ? undefined : args[catFile + 1]
const mode = Bun.env.OPENCODE_SNAPSHOT_GIT_MODE
const preview = args.includes("diff") && args.includes("--cached") && args.includes("--no-ext-diff")
if (preview && mode === "preview-failure") process.exit(42)
if (preview && mode === "preview-overflow") {
  await Bun.write(Bun.stdout, "diff --git a/partial.txt b/partial.txt\\n" + "x".repeat(300_000))
  process.exit(0)
}
  if (preview && mode === "preview-timeout") {
    const pid = Bun.env.OPENCODE_SNAPSHOT_GIT_PID
    if (pid) await Bun.write(pid, String(process.pid))
    process.on("SIGTERM", () => {})
    await new Promise(() => {})
  }
  if (mode === "write-tree-hang" && args.includes("write-tree")) {
    const pid = Bun.env.OPENCODE_SNAPSHOT_GIT_PID
    if (pid) await Bun.write(pid, String(process.pid))
    process.on("SIGTERM", () => {})
    await new Promise(() => {})
  }
if (option?.startsWith("--batch-check")) {
  if (mode === "check-failure") process.exit(42)
  if (mode === "check-malformed") {
    process.stdout.write("malformed\\n")
    process.exit(0)
  }
}
if (option === "--batch" && mode === "batch-failure") process.exit(43)

const child = Bun.spawn([${JSON.stringify(git)}, ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
`,
  )
  yield* Effect.promise(() => fs.chmod(wrapper, 0o755))
  return { directory: wrapperDir, log, pid }
})

const withGitWrapper = <A, E, R>(
  wrapper: { directory: string; log: string; pid: string },
  mode:
    | "record"
    | "check-failure"
    | "check-malformed"
    | "batch-failure"
    | "preview-failure"
    | "preview-overflow"
    | "preview-timeout"
    | "write-tree-hang",
  self: Effect.Effect<A, E, R>,
) =>
  withProcessEnvironment(
    {
      PATH: `${wrapper.directory}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCODE_SNAPSHOT_GIT_LOG: wrapper.log,
      OPENCODE_SNAPSHOT_GIT_MODE: mode,
      OPENCODE_SNAPSHOT_GIT_PID: wrapper.pid,
    },
    self,
  )

const gitCommands = (value: string) =>
  value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])

const serializedPatchBytes = (diffs: readonly Snapshot.FileDiff[]) =>
  diffs.reduce((sum, item) => {
    if (item.patch === undefined) throw new Error(`missing patch for ${item.file}`)
    return sum + Buffer.byteLength(JSON.stringify(item.patch))
  }, 0)

const catFileOption = (command: string[]) => {
  const index = command.indexOf("cat-file")
  return index < 0 ? undefined : command[index + 1]
}

it.instance(
  "tracks deleted files correctly",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* rm(`${tmp.path}/a.txt`)
      expect((yield* snapshot.patch(before)).files).toContain(fwd(tmp.path, "a.txt"))
    }),
  ),
  { git: true },
)

it.instance(
  "patch between tracked snapshots excludes later worktree changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/during-step.txt`, "during")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      yield* write(`${tmp.path}/after-step.txt`, "after")

      const patch = yield* snapshot.patch(before, after!)

      expect(patch.files).toEqual([fwd(tmp.path, "during-step.txt")])
    }),
  ),
  { git: true },
)

it.instance(
  "revert should remove new files",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/new.txt`, "NEW")
      const patch = yield* snapshot.patch(before)
      yield* snapshot.revert([patch])
      expect(yield* exists(`${tmp.path}/new.txt`)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "revert in subdirectory",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* mkdirp(`${tmp.path}/sub`)
      yield* write(`${tmp.path}/sub/file.txt`, "SUB")
      const patch = yield* snapshot.patch(before)
      yield* snapshot.revert([patch])
      expect(yield* exists(`${tmp.path}/sub/file.txt`)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "multiple file operations",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* rm(`${tmp.path}/a.txt`)
      yield* write(`${tmp.path}/c.txt`, "C")
      yield* mkdirp(`${tmp.path}/dir`)
      yield* write(`${tmp.path}/dir/d.txt`, "D")
      yield* write(`${tmp.path}/b.txt`, "MODIFIED")
      const patch = yield* snapshot.patch(before)
      yield* snapshot.revert([patch])
      expect(yield* readText(`${tmp.path}/a.txt`)).toBe(tmp.extra.aContent)
      expect(yield* exists(`${tmp.path}/c.txt`)).toBe(false)
      expect(yield* readText(`${tmp.path}/b.txt`)).toBe(tmp.extra.bContent)
    }),
  ),
  { git: true },
)

it.instance(
  "empty directory handling",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* mkdirp(`${tmp.path}/empty`)
      expect((yield* snapshot.patch(before)).files.length).toBe(0)
    }),
  ),
  { git: true },
)

it.instance(
  "binary file handling",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(fwd(tmp.path, "image.png"))
      yield* snapshot.revert([patch])
      expect(yield* exists(`${tmp.path}/image.png`)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "symlink handling",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.symlink(`${tmp.path}/a.txt`, `${tmp.path}/link.txt`, "file"))
      expect((yield* snapshot.patch(before)).files).toContain(fwd(tmp.path, "link.txt"))
    }),
  ),
  { git: true },
)

it.instance(
  "file under size limit handling",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/large.txt`, "x".repeat(1024 * 1024))
      expect((yield* snapshot.patch(before)).files).toContain(fwd(tmp.path, "large.txt"))
    }),
  ),
  { git: true },
)

it.instance(
  "large added files are skipped",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/huge.txt`, new Uint8Array(2 * 1024 * 1024 + 1))
      expect((yield* snapshot.patch(before)).files).toEqual([])
      expect(yield* snapshot.diff(before)).toBe("")
      expect(yield* snapshot.track()).toBe(before)
    }),
  ),
  { git: true },
)

it.instance(
  "nested directory revert",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* mkdirp(`${tmp.path}/level1/level2/level3`)
      yield* write(`${tmp.path}/level1/level2/level3/deep.txt`, "DEEP")
      const patch = yield* snapshot.patch(before)
      yield* snapshot.revert([patch])
      expect(yield* exists(`${tmp.path}/level1/level2/level3/deep.txt`)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "special characters in filenames",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/file with spaces.txt`, "SPACES")
      yield* write(`${tmp.path}/file-with-dashes.txt`, "DASHES")
      yield* write(`${tmp.path}/file_with_underscores.txt`, "UNDERSCORES")
      const files = (yield* snapshot.patch(before)).files
      expect(files).toContain(fwd(tmp.path, "file with spaces.txt"))
      expect(files).toContain(fwd(tmp.path, "file-with-dashes.txt"))
      expect(files).toContain(fwd(tmp.path, "file_with_underscores.txt"))
    }),
  ),
  { git: true },
)

it.instance(
  "revert with empty patches",
  Effect.gen(function* () {
    yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* snapshot.revert([])
    yield* snapshot.revert([{ hash: "dummy", files: [] }])
  }),
  { git: true },
)

it.instance(
  "patch with invalid hash",
  withTrackedSnapshot(({ tmp, snapshot }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/test.txt`, "TEST")
      const patch = yield* snapshot.patch("invalid-hash-12345")
      expect(patch.files).toEqual([])
      expect(patch.hash).toBe("invalid-hash-12345")
    }),
  ),
  { git: true },
)

it.instance(
  "revert non-existent file",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* snapshot.revert([{ hash: before, files: [`${tmp.path}/nonexistent.txt`] }])
    }),
  ),
  { git: true },
)

it.instance(
  "unicode filenames",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      const unicodeFiles = [
        { path: fwd(tmp.path, "文件.txt"), content: "chinese content" },
        { path: fwd(tmp.path, "🚀rocket.txt"), content: "emoji content" },
        { path: fwd(tmp.path, "café.txt"), content: "accented content" },
        { path: fwd(tmp.path, "файл.txt"), content: "cyrillic content" },
      ]
      yield* Effect.all(
        unicodeFiles.map((file) => write(file.path, file.content)),
        { concurrency: "unbounded" },
      )
      const patch = yield* snapshot.patch(before)
      expect(patch.files.length).toBe(4)
      for (const file of unicodeFiles) expect(patch.files).toContain(file.path)
      yield* snapshot.revert([patch])
      for (const file of unicodeFiles) expect(yield* exists(file.path)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance.skip(
  "unicode filenames modification and restore",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const chineseFile = fwd(tmp.path, "文件.txt")
    const cyrillicFile = fwd(tmp.path, "файл.txt")
    yield* write(chineseFile, "original chinese")
    yield* write(cyrillicFile, "original cyrillic")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(chineseFile, "modified chinese")
    yield* write(cyrillicFile, "modified cyrillic")
    const patch = yield* snapshot.patch(before!)
    expect(patch.files).toContain(chineseFile)
    expect(patch.files).toContain(cyrillicFile)
    yield* snapshot.revert([patch])
    expect(yield* readText(chineseFile)).toBe("original chinese")
    expect(yield* readText(cyrillicFile)).toBe("original cyrillic")
  }),
  { git: true },
)

it.instance(
  "unicode filenames in subdirectories",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* mkdirp(`${tmp.path}/目录/подкаталог`)
      const deepFile = fwd(tmp.path, "目录", "подкаталог", "文件.txt")
      yield* write(deepFile, "deep unicode content")
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(deepFile)
      yield* snapshot.revert([patch])
      expect(yield* exists(deepFile)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "very long filenames",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      const longFile = fwd(tmp.path, `${"a".repeat(200)}.txt`)
      yield* write(longFile, "long filename content")
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(longFile)
      yield* snapshot.revert([patch])
      expect(yield* exists(longFile)).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "hidden files",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/.hidden`, "hidden content")
      yield* write(`${tmp.path}/.gitignore`, "*.log")
      yield* write(`${tmp.path}/.config`, "config content")
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(fwd(tmp.path, ".hidden"))
      expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))
      expect(patch.files).toContain(fwd(tmp.path, ".config"))
    }),
  ),
  { git: true },
)

it.instance(
  "nested symlinks",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* mkdirp(`${tmp.path}/sub/dir`)
      yield* write(`${tmp.path}/sub/dir/target.txt`, "target content")
      yield* Effect.promise(() => fs.symlink(`${tmp.path}/sub/dir/target.txt`, `${tmp.path}/sub/dir/link.txt`, "file"))
      yield* Effect.promise(() => fs.symlink(`${tmp.path}/sub`, `${tmp.path}/sub-link`, "dir"))
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(fwd(tmp.path, "sub", "dir", "link.txt"))
      expect(patch.files).toContain(fwd(tmp.path, "sub-link"))
    }),
  ),
  { git: true },
)

it.instance(
  "file permissions and ownership changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.chmod(`${tmp.path}/a.txt`, 0o600))
      yield* Effect.promise(() => fs.chmod(`${tmp.path}/a.txt`, 0o755))
      yield* Effect.promise(() => fs.chmod(`${tmp.path}/a.txt`, 0o644))
      expect((yield* snapshot.patch(before)).files.length).toBe(0)
    }),
  ),
  { git: true },
)

it.instance(
  "circular symlinks",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.symlink(`${tmp.path}/circular`, `${tmp.path}/circular`, "dir").catch(() => undefined),
      )
      expect((yield* snapshot.patch(before)).files.length).toBeGreaterThanOrEqual(0)
    }),
  ),
  { git: true },
)

it.live(
  "source project gitignore is respected - ignored files are not snapshotted",
  Effect.gen(function* () {
    const dir = yield* scopedGitTmpdir()
    yield* write(`${dir}/.gitignore`, "*.ignored\nbuild/\nnode_modules/\n")
    yield* write(`${dir}/tracked.txt`, "tracked content")
    yield* write(`${dir}/ignored.ignored`, "ignored content")
    yield* mkdirp(`${dir}/build`)
    yield* write(`${dir}/build/output.js`, "build output")
    yield* write(`${dir}/normal.js`, "normal js")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      yield* write(`${dir}/tracked.txt`, "modified tracked")
      yield* write(`${dir}/new.ignored`, "new ignored")
      yield* write(`${dir}/new-tracked.txt`, "new tracked")
      yield* write(`${dir}/build/new-build.js`, "new build file")
      const patch = yield* snapshot.patch(before!)
      expect(patch.files).toContain(fwd(dir, "new-tracked.txt"))
      expect(patch.files).toContain(fwd(dir, "tracked.txt"))
      expect(patch.files).not.toContain(fwd(dir, "new.ignored"))
      expect(patch.files).not.toContain(fwd(dir, "ignored.ignored"))
      expect(patch.files).not.toContain(fwd(dir, "build/output.js"))
      expect(patch.files).not.toContain(fwd(dir, "build/new-build.js"))
    }).pipe(provideInstance(dir))
  }),
)

it.live(
  "subdirectory snapshots include scoped changes only",
  Effect.gen(function* () {
    const dir = yield* scopedGitTmpdir()
    const frontend = path.join(dir, "frontend")
    yield* write(`${frontend}/tracked.txt`, "initial")
    yield* write(`${frontend}/deleted.txt`, "initial")
    yield* write(`${dir}/backend/tracked.txt`, "initial")
    yield* write(`${dir}/backend/deleted.txt`, "initial")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      yield* write(`${frontend}/tracked.txt`, "changed")
      yield* write(`${frontend}/untracked.txt`, "new")
      yield* rm(`${frontend}/deleted.txt`)
      yield* write(`${dir}/backend/tracked.txt`, "changed")
      yield* rm(`${dir}/backend/deleted.txt`)
      const patch = yield* snapshot.patch(before!)
      const diff = yield* snapshot.diff(before!)
      expect(patch.files).toContain(fwd(frontend, "tracked.txt"))
      expect(patch.files).toContain(fwd(frontend, "untracked.txt"))
      expect(patch.files).toContain(fwd(frontend, "deleted.txt"))
      expect(patch.files).not.toContain(fwd(dir, "backend", "tracked.txt"))
      expect(patch.files).not.toContain(fwd(dir, "backend", "deleted.txt"))
      expect(diff).not.toContain("backend/tracked.txt")
      expect(diff).not.toContain("backend/deleted.txt")
    }).pipe(provideInstance(frontend))
  }),
)

nonWindowsIt(
  "subdirectory snapshots treat wildcard characters literally",
  Effect.gen(function* () {
    const dir = yield* scopedGitTmpdir()
    const subdir = path.join(dir, "src*")
    yield* write(`${subdir}/file.txt`, "initial")
    yield* write(`${subdir}/later-ignored.txt`, "initial")
    yield* write(`${dir}/srca/file.txt`, "initial")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      yield* write(`${subdir}/file.txt`, "changed")
      yield* write(`${subdir}/later-ignored.txt`, "changed")
      yield* write(`${subdir}/.gitignore`, "later-ignored.txt\n")
      yield* write(`${dir}/srca/file.txt`, "changed")
      const patch = yield* snapshot.patch(before!)
      const diff = yield* snapshot.diff(before!)
      expect(patch.files).toContain(fwd(subdir, "file.txt"))
      expect(patch.files).toContain(fwd(subdir, ".gitignore"))
      expect(patch.files).not.toContain(fwd(subdir, "later-ignored.txt"))
      expect(patch.files).not.toContain(fwd(dir, "srca", "file.txt"))
      expect(diff).toContain("src*/later-ignored.txt")
      expect(diff).toContain("deleted file mode")
      expect(diff).not.toContain("srca/file.txt")
    }).pipe(provideInstance(subdir))
  }),
)

nonWindowsIt(
  "subdirectory snapshots treat leading colons literally",
  Effect.gen(function* () {
    const dir = yield* scopedGitTmpdir()
    const subdir = path.join(dir, ":src")
    yield* write(`${subdir}/kept.txt`, "initial")
    yield* write(`${subdir}/later-ignored.txt`, "initial")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      yield* write(`${subdir}/kept.txt`, "changed")
      yield* write(`${subdir}/later-ignored.txt`, "changed")
      yield* write(`${subdir}/.gitignore`, "later-ignored.txt\n")
      const patch = yield* snapshot.patch(before!)
      const diff = yield* snapshot.diff(before!)
      expect(patch.files).toContain(fwd(subdir, "kept.txt"))
      expect(patch.files).toContain(fwd(subdir, ".gitignore"))
      expect(patch.files).not.toContain(fwd(subdir, "later-ignored.txt"))
      expect(diff).toContain(":src/later-ignored.txt")
      expect(diff).toContain("deleted file mode")
    }).pipe(provideInstance(subdir))
  }),
)

it.instance(
  "gitignore changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/.gitignore`, "*.ignored")
      yield* write(`${tmp.path}/test.ignored`, "ignored content")
      yield* write(`${tmp.path}/normal.txt`, "normal content")
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))
      expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
      expect(patch.files).not.toContain(fwd(tmp.path, "test.ignored"))
    }),
  ),
  { git: true },
)

it.instance(
  "files tracked in snapshot but now gitignored are filtered out",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/later-ignored.txt`, "initial content")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/later-ignored.txt`, "modified content")
    yield* write(`${tmp.path}/.gitignore`, "later-ignored.txt\n")
    yield* write(`${tmp.path}/still-tracked.txt`, "new tracked file")
    const patch = yield* snapshot.patch(before!)
    expect(patch.files).not.toContain(fwd(tmp.path, "later-ignored.txt"))
    expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))
    expect(patch.files).toContain(fwd(tmp.path, "still-tracked.txt"))
  }),
  { git: true },
)

it.instance(
  "gitignore updated between track calls filters from diff",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/a.txt`, "modified content")
      yield* write(`${tmp.path}/.gitignore`, "a.txt\n")
      yield* write(`${tmp.path}/b.txt`, "also modified")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.some((x) => x.file === "a.txt")).toBe(false)
      expect(diffs.some((x) => x.file === ".gitignore")).toBe(true)
      expect(diffs.some((x) => x.file === "b.txt")).toBe(true)
    }),
  ),
  { git: true },
)

it.instance(
  "git info exclude changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      const file = `${tmp.path}/.git/info/exclude`
      yield* write(file, `${(yield* Effect.promise(() => Bun.file(file).text())).trimEnd()}\nignored.txt\n`)
      yield* write(`${tmp.path}/ignored.txt`, "ignored content")
      yield* write(`${tmp.path}/normal.txt`, "normal content")
      const patch = yield* snapshot.patch(before)
      expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
      expect(patch.files).not.toContain(fwd(tmp.path, "ignored.txt"))
      const after = yield* snapshot.track()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.some((x) => x.file === "normal.txt")).toBe(true)
      expect(diffs.some((x) => x.file === "ignored.txt")).toBe(false)
    }),
  ),
  { git: true },
)

it.instance(
  "git info exclude keeps global excludes",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const global = `${tmp.path}/global.ignore`
    const config = `${tmp.path}/global.gitconfig`
    yield* write(global, "global.tmp\n")
    yield* write(config, `[core]\n\texcludesFile = ${global.replaceAll("\\", "/")}\n`)
    yield* withGitConfigGlobal(
      config,
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* snapshot.track()
        expect(before).toBeTruthy()
        const file = `${tmp.path}/.git/info/exclude`
        yield* write(file, `${(yield* Effect.promise(() => Bun.file(file).text())).trimEnd()}\ninfo.tmp\n`)
        yield* write(`${tmp.path}/global.tmp`, "global content")
        yield* write(`${tmp.path}/info.tmp`, "info content")
        yield* write(`${tmp.path}/normal.txt`, "normal content")
        const patch = yield* snapshot.patch(before!)
        expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
        expect(patch.files).not.toContain(fwd(tmp.path, "global.tmp"))
        expect(patch.files).not.toContain(fwd(tmp.path, "info.tmp"))
      }),
    )
  }),
  { git: true },
)

it.instance(
  "concurrent file operations during patch",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.gen(function* () {
        for (let i = 0; i < 10; i++) {
          yield* write(`${tmp.path}/concurrent${i}.txt`, `concurrent${i}`)
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.forkScoped)
      const patch = yield* snapshot.patch(before)
      yield* Fiber.join(fiber)
      expect(patch.files.length).toBeGreaterThanOrEqual(0)
    }),
  ),
  { git: true },
)

it.live(
  "snapshot state isolation between projects",
  Effect.gen(function* () {
    const tmp1 = yield* bootstrapScoped()
    const tmp2 = yield* bootstrapScoped()
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before1 = yield* snapshot.track()
      yield* write(`${tmp1.path}/project1.txt`, "project1 content")
      const patch1 = yield* snapshot.patch(before1!)
      expect(patch1.files).toContain(fwd(tmp1.path, "project1.txt"))
    }).pipe(provideInstance(tmp1.path))
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before2 = yield* snapshot.track()
      yield* write(`${tmp2.path}/project2.txt`, "project2 content")
      const patch2 = yield* snapshot.patch(before2!)
      expect(patch2.files).toContain(fwd(tmp2.path, "project2.txt"))
      expect(patch2.files).not.toContain(fwd(tmp1.path, "project1.txt"))
    }).pipe(provideInstance(tmp2.path))
  }),
)

it.live(
  "patch detects changes in secondary worktree",
  Effect.gen(function* () {
    const tmp = yield* bootstrapScoped()
    const worktreePath = `${tmp.path}-worktree`
    yield* exec(tmp.path, ["git", "worktree", "add", worktreePath, "HEAD"])
    yield* Effect.addFinalizer(() => cleanupWorktree(tmp.path, worktreePath))
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.track()).toBeTruthy()
    }).pipe(provideInstance(tmp.path))
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      const worktreeFile = fwd(worktreePath, "worktree.txt")
      yield* write(worktreeFile, "worktree content")
      expect((yield* snapshot.patch(before!)).files).toContain(worktreeFile)
    }).pipe(provideInstance(worktreePath))
  }),
)

it.live(
  "revert only removes files in invoking worktree",
  Effect.gen(function* () {
    const tmp = yield* bootstrapScoped()
    const worktreePath = `${tmp.path}-worktree`
    const primaryFile = `${tmp.path}/worktree.txt`
    yield* exec(tmp.path, ["git", "worktree", "add", worktreePath, "HEAD"])
    yield* Effect.addFinalizer(() => cleanupWorktree(tmp.path, worktreePath, [primaryFile]))
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.track()).toBeTruthy()
    }).pipe(provideInstance(tmp.path))
    yield* write(primaryFile, "primary content")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      const worktreeFile = fwd(worktreePath, "worktree.txt")
      yield* write(worktreeFile, "worktree content")
      const patch = yield* snapshot.patch(before!)
      yield* snapshot.revert([patch])
      expect(yield* exists(worktreeFile)).toBe(false)
    }).pipe(provideInstance(worktreePath))
    expect(yield* readText(primaryFile)).toBe("primary content")
  }),
)

it.live(
  "diff reports worktree-only/shared edits and ignores primary-only",
  Effect.gen(function* () {
    const tmp = yield* bootstrapScoped()
    const worktreePath = `${tmp.path}-worktree`
    yield* exec(tmp.path, ["git", "worktree", "add", worktreePath, "HEAD"])
    yield* Effect.addFinalizer(() =>
      cleanupWorktree(tmp.path, worktreePath, [`${tmp.path}/shared.txt`, `${tmp.path}/primary-only.txt`]),
    )
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.track()).toBeTruthy()
    }).pipe(provideInstance(tmp.path))
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      yield* write(`${worktreePath}/worktree-only.txt`, "worktree diff content")
      yield* write(`${worktreePath}/shared.txt`, "worktree edit")
      yield* write(`${tmp.path}/shared.txt`, "primary edit")
      yield* write(`${tmp.path}/primary-only.txt`, "primary change")
      const diff = yield* snapshot.diff(before!)
      expect(diff).toContain("worktree-only.txt")
      expect(diff).toContain("shared.txt")
      expect(diff).not.toContain("primary-only.txt")
    }).pipe(provideInstance(worktreePath))
  }),
)

it.instance(
  "track with no changes returns same hash",
  withTrackedSnapshot(({ snapshot, before }) =>
    Effect.gen(function* () {
      expect(yield* snapshot.track()).toBe(before)
      expect(yield* snapshot.track()).toBe(before)
    }),
  ),
  { git: true },
)

it.instance(
  "diff function with various changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* rm(`${tmp.path}/a.txt`)
      yield* write(`${tmp.path}/new.txt`, "new content")
      yield* write(`${tmp.path}/b.txt`, "modified content")
      const diff = yield* snapshot.diff(before)
      expect(diff).toContain("a.txt")
      expect(diff).toContain("b.txt")
      expect(diff).toContain("new.txt")
    }),
  ),
  { git: true },
)

it.instance(
  "sessionPreviewDiff keeps small raw git patches byte-identical to legacy diff",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/exact-é.txt`, "\uFEFFone\r\ntwo\tend")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBe("")

    yield* write(`${tmp.path}/exact-é.txt`, "\uFEFFone\r\nthree\t🙂")
    const legacy = yield* snapshot.diff(before!)
    const preview = yield* snapshot.sessionPreviewDiff(before!)
    expect(preview).toBe(legacy)
    expect(preview).toContain("diff --git a/exact-é.txt b/exact-é.txt")
    expect(preview).toContain("-two\tend")
    expect(preview).toContain("+three\t🙂")
    expect(preview).toContain("\\ No newline at end of file")
    expect(preview?.endsWith("\n")).toBe(false)
  }),
  { git: true },
)

it.instance(
  "sessionPreviewDiff includes the exact serialized JSON boundary and omits one byte over",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/boundary.txt`, "a")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    yield* write(`${tmp.path}/boundary.txt`, "b")
    const base = yield* snapshot.diff(before!)
    const baseBytes = Buffer.byteLength(JSON.stringify(base))
    expect(baseBytes).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    const extra = StructuredFileDiff.MAX_PATCH_BYTES - baseBytes

    yield* write(`${tmp.path}/boundary.txt`, "b".repeat(1 + extra))
    const exactLegacy = yield* snapshot.diff(before!)
    expect(Buffer.byteLength(JSON.stringify(exactLegacy))).toBe(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBe(exactLegacy)

    yield* write(`${tmp.path}/boundary.txt`, "b".repeat(2 + extra))
    const overLegacy = yield* snapshot.diff(before!)
    expect(Buffer.byteLength(JSON.stringify(overLegacy))).toBe(StructuredFileDiff.MAX_PATCH_BYTES + 1)
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "sessionPreviewDiff counts JSON escapes even when raw output stays below the cap",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/escaped.txt`, "before")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/escaped.txt`, "\t".repeat(150_000))

    const legacy = yield* snapshot.diff(before!)
    expect(Buffer.byteLength(legacy)).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "sessionPreviewDiff conservatively omits oversized raw trailing whitespace before legacy trim",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/spaces.txt`, "before\n")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/spaces.txt`, `${" ".repeat(StructuredFileDiff.MAX_PATCH_BYTES + 1)}\n`)

    const legacy = yield* snapshot.diff(before!)
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "sessionPreviewDiff bounds huge single-line and sparse raw output without changing legacy diff",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/huge.txt`, "before")
    const sparse = Array.from({ length: 50_000 }, (_, i) => `v${i}`).join("\n")
    yield* write(`${tmp.path}/sparse.txt`, sparse)
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    yield* write(`${tmp.path}/huge.txt`, "x".repeat(StructuredFileDiff.MAX_PATCH_BYTES + 100_000))
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBeUndefined()
    const hugeLegacy = yield* snapshot.diff(before!)
    expect(typeof hugeLegacy).toBe("string")
    expect(Buffer.byteLength(JSON.stringify(hugeLegacy))).toBeGreaterThan(StructuredFileDiff.MAX_PATCH_BYTES)

    yield* write(`${tmp.path}/huge.txt`, "before")
    yield* write(
      `${tmp.path}/sparse.txt`,
      Array.from({ length: 50_000 }, (_, i) => (i % 8 === 0 ? `changed-${i}` : `v${i}`)).join("\n"),
    )
    expect(yield* snapshot.sessionPreviewDiff(before!)).toBeUndefined()
    const sparseLegacy = yield* snapshot.diff(before!)
    expect(typeof sparseLegacy).toBe("string")
    expect(Buffer.byteLength(JSON.stringify(sparseLegacy))).toBeGreaterThan(StructuredFileDiff.MAX_PATCH_BYTES)
  }),
  { git: true },
  { timeout: 15_000 },
)

it.instance(
  "sessionPreviewDiff discards truncated and failed process output",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/changed.txt`, "changed")
    const wrapper = yield* makeGitWrapper(yield* scopedTmpdir())

    expect(yield* withGitWrapper(wrapper, "preview-overflow", snapshot.sessionPreviewDiff(before!))).toBeUndefined()
    expect(yield* withGitWrapper(wrapper, "preview-failure", snapshot.sessionPreviewDiff(before!))).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "sessionPreviewDiff force-kills a SIGTERM-ignoring timed-out git process",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/changed.txt`, "changed")
    const wrapper = yield* makeGitWrapper(yield* scopedTmpdir())

    expect(yield* withGitWrapper(wrapper, "preview-timeout", snapshot.sessionPreviewDiff(before!))).toBeUndefined()
    const pid = Number((yield* readText(wrapper.pid)).trim())
    expect(Number.isSafeInteger(pid)).toBe(true)
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return
        } catch {
          return true
        }
      }),
      "timed-out git wrapper was not force-killed",
    )
  }),
  { git: true },
  { timeout: 15_000 },
)

it.instance(
  "a hanging write-path git op is bounded and releases the shared snapshot lock without an orphan",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/changed.txt`, "changed")
    const wrapper = yield* makeGitWrapper(yield* scopedTmpdir())

    yield* withProcessEnvironment(
      {
        OPENCODE_SNAPSHOT_GIT_TIMEOUT: "5000",
        OPENCODE_SNAPSHOT_GIT_FORCEKILL: "1000",
      },
      Effect.gen(function* () {
        // write-tree hangs forever; the git helper default timeout must bound it.
        const hungHash = yield* withGitWrapper(wrapper, "write-tree-hang", snapshot.track())
        expect(hungHash).toBe("")

        // The shared per-worktree lock must have been released by the deadline,
        // so a subsequent track can still acquire it and complete.
        yield* write(`${tmp.path}/changed.txt`, "changed again")
        const hashAfter = yield* withGitWrapper(wrapper, "record", snapshot.track())
        expect(hashAfter).toBeTruthy()

        const pid = Number((yield* readText(wrapper.pid)).trim())
        expect(Number.isSafeInteger(pid)).toBe(true)
        yield* pollWithTimeout(
          Effect.sync(() => {
            try {
              process.kill(pid, 0)
              return
            } catch {
              return true
            }
          }),
          "hung write-path git wrapper was not force-killed",
        )
      }),
    )
  }),
  { git: true },
  { timeout: 30_000 },
)

it.instance(
  "restore function",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* rm(`${tmp.path}/a.txt`)
      yield* write(`${tmp.path}/new.txt`, "new content")
      yield* write(`${tmp.path}/b.txt`, "modified")
      yield* snapshot.restore(before)
      expect(yield* exists(`${tmp.path}/a.txt`)).toBe(true)
      expect(yield* readText(`${tmp.path}/a.txt`)).toBe(tmp.extra.aContent)
      expect(yield* exists(`${tmp.path}/new.txt`)).toBe(true)
      expect(yield* readText(`${tmp.path}/b.txt`)).toBe(tmp.extra.bContent)
    }),
  ),
  { git: true },
)

it.instance(
  "revert should not delete files that existed but were deleted in snapshot",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const snapshot1 = yield* snapshot.track()
    expect(snapshot1).toBeTruthy()
    yield* rm(`${tmp.path}/a.txt`)
    const snapshot2 = yield* snapshot.track()
    expect(snapshot2).toBeTruthy()
    yield* write(`${tmp.path}/a.txt`, "recreated content")
    const patch = yield* snapshot.patch(snapshot2!)
    expect(patch.files).toContain(fwd(tmp.path, "a.txt"))
    yield* snapshot.revert([patch])
    expect(yield* exists(`${tmp.path}/a.txt`)).toBe(false)
  }),
  { git: true },
)

it.instance(
  "revert preserves file that existed in snapshot when deleted then recreated",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/existing.txt`, "original content")
    const hash = yield* snapshot.track()
    expect(hash).toBeTruthy()
    yield* rm(`${tmp.path}/existing.txt`)
    yield* write(`${tmp.path}/existing.txt`, "recreated")
    yield* write(`${tmp.path}/newfile.txt`, "new")
    const patch = yield* snapshot.patch(hash!)
    expect(patch.files).toContain(fwd(tmp.path, "existing.txt"))
    expect(patch.files).toContain(fwd(tmp.path, "newfile.txt"))
    yield* snapshot.revert([patch])
    expect(yield* exists(`${tmp.path}/newfile.txt`)).toBe(false)
    expect(yield* exists(`${tmp.path}/existing.txt`)).toBe(true)
    expect(yield* readText(`${tmp.path}/existing.txt`)).toBe("original content")
  }),
  { git: true },
)

it.instance(
  "diffFull sets status based on git change type",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/grow.txt`, "one\n")
    yield* write(`${tmp.path}/trim.txt`, "line1\nline2\n")
    yield* write(`${tmp.path}/delete.txt`, "gone")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/grow.txt`, "one\ntwo\n")
    yield* write(`${tmp.path}/trim.txt`, "line1\n")
    yield* rm(`${tmp.path}/delete.txt`)
    yield* write(`${tmp.path}/added.txt`, "new")
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    const diffs = yield* snapshot.diffFull(before!, after!)
    const summary = yield* snapshot.diffSummary(before!, after!)
    expect(diffs.length).toBe(4)
    expect(summary).toEqual(
      diffs.map((diff) => ({
        file: diff.file,
        additions: diff.additions,
        deletions: diff.deletions,
        status: diff.status,
      })),
    )
    expect(diffs.find((d) => d.file === "added.txt")!.status).toBe("added")
    expect(diffs.find((d) => d.file === "delete.txt")!.status).toBe("deleted")
    const grow = diffs.find((d) => d.file === "grow.txt")!
    expect(grow.status).toBe("modified")
    expect(grow.additions).toBeGreaterThan(0)
    expect(grow.deletions).toBe(0)
    const trim = diffs.find((d) => d.file === "trim.txt")!
    expect(trim.status).toBe("modified")
    expect(trim.additions).toBe(0)
    expect(trim.deletions).toBeGreaterThan(0)
  }),
  { git: true },
)

nonWindowsInstanceIt(
  "diffFull keeps small full-context text, binary, and mode-only patches byte-identical",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/exact-é.txt`, "one\r\ntwo")
    yield* write(`${tmp.path}/binary.bin`, new Uint8Array([0, 1, 2]))
    yield* write(`${tmp.path}/mode.txt`, "mode\n")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    yield* write(`${tmp.path}/exact-é.txt`, "one\r\nthree")
    yield* write(`${tmp.path}/binary.bin`, new Uint8Array([0, 2, 3]))
    yield* Effect.promise(() => fs.chmod(`${tmp.path}/mode.txt`, 0o755))
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()

    const diffs = yield* snapshot.diffFull(before!, after!)
    expect(diffs).toHaveLength(3)
    expect(diffs.find((item) => item.file === "exact-é.txt")).toEqual({
      file: "exact-é.txt",
      patch:
        "Index: exact-é.txt\n===================================================================\n--- exact-é.txt\t\n+++ exact-é.txt\t\n@@ -1,2 +1,2 @@\n one\r\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified",
    })
    expect(diffs.find((item) => item.file === "binary.bin")).toEqual({
      file: "binary.bin",
      patch: "",
      additions: 0,
      deletions: 0,
      status: "modified",
    })
    expect(diffs.find((item) => item.file === "mode.txt")).toEqual({
      file: "mode.txt",
      patch:
        "Index: mode.txt\n===================================================================\n--- mode.txt\t\n+++ mode.txt\t\n",
      additions: 0,
      deletions: 0,
      status: "modified",
    })
  }),
  { git: true },
)

it.instance(
  "diffFull keeps the exact aggregate JSON patch boundary and omits every patch one byte over",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/a.txt`, "a")
    yield* write(`${tmp.path}/b.txt`, "a")
    yield* write(`${tmp.path}/z.bin`, new Uint8Array([0, 1]))
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    yield* write(`${tmp.path}/a.txt`, "b")
    yield* write(`${tmp.path}/b.txt`, "c")
    yield* write(`${tmp.path}/z.bin`, new Uint8Array([0, 2]))
    const base = yield* snapshot.track()
    expect(base).toBeTruthy()
    const baseDiff = yield* snapshot.diffFull(before!, base!)
    expect(baseDiff.every((item) => item.patch !== undefined)).toBe(true)
    expect(baseDiff.find((item) => item.file === "z.bin")?.patch).toBe("")
    expect(Buffer.byteLength(JSON.stringify(""))).toBe(2)
    const baseBytes = serializedPatchBytes(baseDiff)
    expect(baseBytes).toBeLessThan(StructuredFileDiff.MAX_PATCH_BYTES)

    const extra = StructuredFileDiff.MAX_PATCH_BYTES - baseBytes
    yield* write(`${tmp.path}/b.txt`, "c".repeat(1 + extra))
    const exactSnapshot = yield* snapshot.track()
    expect(exactSnapshot).toBeTruthy()
    const exact = yield* snapshot.diffFull(before!, exactSnapshot!)
    expect(exact.every((item) => item.patch !== undefined)).toBe(true)
    expect(serializedPatchBytes(exact)).toBe(StructuredFileDiff.MAX_PATCH_BYTES)

    yield* write(`${tmp.path}/b.txt`, "c".repeat(2 + extra))
    const overSnapshot = yield* snapshot.track()
    expect(overSnapshot).toBeTruthy()
    const over = yield* snapshot.diffFull(before!, overSnapshot!)
    expect(over.map((item) => item.file)).toEqual(exact.map((item) => item.file))
    expect(over.map((item) => [item.additions, item.deletions, item.status])).toEqual(
      exact.map((item) => [item.additions, item.deletions, item.status]),
    )
    expect(over.every((item) => !("patch" in item))).toBe(true)
    expect(JSON.stringify(over)).not.toContain("c".repeat(100))
  }),
  { git: true },
)

it.instance(
  "diffFull rejects excessive changed lines before inspecting or loading blobs",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const lines = 65_537
    yield* write(`${tmp.path}/dense.txt`, Array.from({ length: lines }, (_, i) => `before-${i}`).join("\n"))
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/dense.txt`, Array.from({ length: lines }, (_, i) => `after-${i}`).join("\n"))
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()

    const wrapper = yield* makeGitWrapper(tmp.path)
    yield* write(wrapper.log, "")
    const diffs = yield* withGitWrapper(wrapper, "record", snapshot.diffFull(before!, after!))
    expect(diffs).toEqual([
      {
        file: "dense.txt",
        additions: lines,
        deletions: lines,
        status: "modified",
      },
    ])
    const commands = gitCommands(yield* readText(wrapper.log))
    expect(commands.some((command) => catFileOption(command)?.startsWith("--batch-check"))).toBe(false)
    expect(commands.some((command) => catFileOption(command) === "--batch")).toBe(false)
    expect(commands.some((command) => command.includes("show"))).toBe(false)
  }),
  { git: true },
  { timeout: 10_000 },
)

it.instance(
  "diffFull inspects blob sizes but never loads oversized full-context inputs",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const size = StructuredFileDiff.MAX_PATCH_BYTES + 1
    yield* write(`${tmp.path}/huge.txt`, "a".repeat(size))
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/huge.txt`, "b".repeat(size))
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()

    const wrapper = yield* makeGitWrapper(tmp.path)
    yield* write(wrapper.log, "")
    expect(yield* withGitWrapper(wrapper, "record", snapshot.diffFull(before!, after!))).toEqual([
      {
        file: "huge.txt",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ])
    const commands = gitCommands(yield* readText(wrapper.log))
    expect(commands.filter((command) => catFileOption(command)?.startsWith("--batch-check"))).toHaveLength(1)
    expect(commands.some((command) => catFileOption(command) === "--batch")).toBe(false)
    expect(commands.some((command) => command.includes("show"))).toBe(false)
  }),
  { git: true },
)

it.instance(
  "diffFull fails closed when blob inspection fails or returns malformed output",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/checked.txt`, "before")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/checked.txt`, "after")
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    const wrapper = yield* makeGitWrapper(tmp.path)

    yield* Effect.forEach(["check-failure", "check-malformed"] as const, (mode) =>
      Effect.gen(function* () {
        yield* write(wrapper.log, "")
        expect(yield* withGitWrapper(wrapper, mode, snapshot.diffFull(before!, after!))).toEqual([
          {
            file: "checked.txt",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ])
        const commands = gitCommands(yield* readText(wrapper.log))
        expect(commands.filter((command) => catFileOption(command)?.startsWith("--batch-check"))).toHaveLength(1)
        expect(commands.some((command) => catFileOption(command) === "--batch")).toBe(false)
        expect(commands.some((command) => command.includes("show"))).toBe(false)
      }),
    )
  }),
  { git: true },
)

it.instance(
  "diffFull falls back to bounded per-ref reads only after successful blob inspection",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/fallback.txt`, "before")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/fallback.txt`, "after")
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    const wrapper = yield* makeGitWrapper(tmp.path)
    yield* write(wrapper.log, "")

    const diffs = yield* withGitWrapper(wrapper, "batch-failure", snapshot.diffFull(before!, after!))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.patch).toContain("-before")
    expect(diffs[0]?.patch).toContain("+after")
    const commands = gitCommands(yield* readText(wrapper.log))
    expect(commands.filter((command) => catFileOption(command)?.startsWith("--batch-check"))).toHaveLength(1)
    expect(commands.filter((command) => catFileOption(command) === "--batch")).toHaveLength(1)
    expect(commands.filter((command) => command.includes("show"))).toHaveLength(2)
  }),
  { git: true },
)

it.instance(
  "diffFull shares one diff deadline and removes earlier patches after a later timeout",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const files = Array.from({ length: 48 }, (_, i) => `dense/${i.toString().padStart(2, "0")}.txt`)
    yield* write(`${tmp.path}/00-small.txt`, "before")
    yield* Effect.all(
      files.map((file) => write(`${tmp.path}/${file}`, Array.from({ length: 250 }, (_, i) => `a${i}`).join("\n"))),
      { concurrency: "unbounded" },
    )
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/00-small.txt`, "after")
    yield* Effect.all(
      files.map((file) => write(`${tmp.path}/${file}`, Array.from({ length: 250 }, (_, i) => `b${i}`).join("\n"))),
      { concurrency: "unbounded" },
    )
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()

    const diffs = yield* snapshot.diffFull(before!, after!)
    expect(diffs.map((item) => item.file)).toEqual(["00-small.txt", ...files])
    expect(diffs.every((item) => !("patch" in item))).toBe(true)
    expect(diffs[0]).toEqual({
      file: "00-small.txt",
      additions: 1,
      deletions: 1,
      status: "modified",
    })
    expect(diffs.slice(1).every((item) => item.additions === 250 && item.deletions === 250)).toBe(true)
  }),
  { git: true },
  { timeout: 10_000 },
)

it.instance(
  "patchless full-context previews do not limit snapshot revert or restore",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const original = "a".repeat(StructuredFileDiff.MAX_PATCH_BYTES + 1)
    const changed = "b".repeat(StructuredFileDiff.MAX_PATCH_BYTES + 1)
    yield* write(`${tmp.path}/restore.txt`, original)
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/restore.txt`, changed)
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    expect(yield* snapshot.diffFull(before!, after!)).toEqual([
      { file: "restore.txt", additions: 1, deletions: 1, status: "modified" },
    ])

    const patch = yield* snapshot.patch(before!, after!)
    yield* snapshot.revert([patch])
    expect(yield* readText(`${tmp.path}/restore.txt`)).toBe(original)
    yield* snapshot.restore(after!)
    expect(yield* readText(`${tmp.path}/restore.txt`)).toBe(changed)
  }),
  { git: true },
)

it.instance(
  "diffSummary distinguishes an empty diff from missing snapshots",
  withTrackedSnapshot(({ snapshot, before }) =>
    Effect.gen(function* () {
      expect(yield* snapshot.diffSummary(before, before)).toEqual([])
      expect(yield* snapshot.diffSummary("missing-before", "missing-after")).toBeUndefined()
      expect(yield* snapshot.diffFullAvailable(before, before)).toEqual([])
      expect(yield* snapshot.diffFullAvailable("missing-before", "missing-after")).toBeUndefined()
    }),
  ),
  { git: true },
)

it.instance(
  "pins session diff snapshots across git gc and releases them by scope",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/pinned.txt`, "pinned content")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const source = { sessionID: "ses_source", messageID: "msg_source" }
      const copy = { sessionID: "ses_copy", messageID: "msg_copy" }
      expect(yield* snapshot.pinDiff({ ...source, from: before, to: after! })).toBe(true)

      const context = yield* InstanceState.context
      const gitdir = path.join(Global.Path.data, "snapshot", context.project.id, Hash.fast(context.worktree))
      yield* exec(tmp.path, ["git", "--git-dir", gitdir, "gc", "--prune=now"])
      expect(yield* snapshot.diffPinned({ ...source, from: after!, to: before })).toBeUndefined()
      expect((yield* snapshot.diffPinned(source))?.[0]?.patch).toContain("+pinned content")
      expect((yield* snapshot.diffPinned({ ...source, from: before, to: after! }))?.[0]?.patch).toContain(
        "+pinned content",
      )

      expect(yield* snapshot.copyDiffPin({ from: source, to: copy })).toBe(true)
      yield* snapshot.unpinDiff(source)
      expect(yield* snapshot.diffPinned(source)).toBeUndefined()
      expect((yield* snapshot.diffPinned(copy))?.[0]?.patch).toContain("+pinned content")

      yield* snapshot.unpinSessionDiffs(copy.sessionID)
      expect(yield* snapshot.diffPinned(copy)).toBeUndefined()
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with new file additions",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/new.txt`, "new content")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(1)
      expect(diffs[0].file).toBe("new.txt")
      expect(diffs[0].patch).toContain("+new content")
      expect(diffs[0].additions).toBe(1)
      expect(diffs[0].deletions).toBe(0)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with a large interleaved mixed diff",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const ids = Array.from({ length: MIXED_BATCH_GROUP_COUNT }, (_, i) => i.toString().padStart(3, "0"))
    const mod = ids.map((id) => fwd(tmp.path, "mix", `${id}-mod.txt`))
    const del = ids.map((id) => fwd(tmp.path, "mix", `${id}-del.txt`))
    const add = ids.map((id) => fwd(tmp.path, "mix", `${id}-add.txt`))
    const bin = ids.map((id) => fwd(tmp.path, "mix", `${id}-bin.bin`))
    yield* mkdirp(`${tmp.path}/mix`)
    yield* Effect.all(
      [
        ...mod.map((file, i) => write(file, `before-${ids[i]}-é\n🙂\nline`)),
        ...del.map((file, i) => write(file, `gone-${ids[i]}\n你好`)),
        ...bin.map((file, i) => write(file, new Uint8Array([0, i, 255, i % 251]))),
      ],
      { concurrency: "unbounded" },
    )
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* Effect.all(
      [
        ...mod.map((file, i) => write(file, `after-${ids[i]}-é\n🚀\nline`)),
        ...add.map((file, i) => write(file, `new-${ids[i]}\nこんにちは`)),
        ...bin.map((file, i) => write(file, new Uint8Array([9, i, 8, i % 251]))),
        ...del.map((file) => rm(file)),
      ],
      { concurrency: "unbounded" },
    )
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    const diffs = yield* snapshot.diffFull(before!, after!)
    expect(diffs).toHaveLength(ids.length * 4)
    const map = new Map(diffs.map((item) => [item.file, item]))
    for (let i = 0; i < ids.length; i++) {
      const m = map.get(fwd("mix", `${ids[i]}-mod.txt`))
      expect(m).toBeDefined()
      expect(m!.patch).toContain(`-before-${ids[i]}-é`)
      expect(m!.patch).toContain(`+after-${ids[i]}-é`)
      expect(m!.status).toBe("modified")
      const d = map.get(fwd("mix", `${ids[i]}-del.txt`))
      expect(d).toBeDefined()
      expect(d!.patch).toContain(`-gone-${ids[i]}`)
      expect(d!.status).toBe("deleted")
      const a = map.get(fwd("mix", `${ids[i]}-add.txt`))
      expect(a).toBeDefined()
      expect(a!.patch).toContain(`+new-${ids[i]}`)
      expect(a!.status).toBe("added")
      const b = map.get(fwd("mix", `${ids[i]}-bin.bin`))
      expect(b).toBeDefined()
      expect(b!.patch).toBe("")
      expect(b!.additions).toBe(0)
      expect(b!.deletions).toBe(0)
      expect(b!.status).toBe("modified")
    }
  }),
  { git: true },
)

it.instance(
  "diffFull preserves git diff order across batch boundaries",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const ids = Array.from({ length: OVER_BATCH_COUNT }, (_, i) => i.toString().padStart(3, "0"))
    yield* mkdirp(`${tmp.path}/order`)
    yield* Effect.all(
      ids.map((id) => write(`${tmp.path}/order/${id}.txt`, `before-${id}`)),
      { concurrency: "unbounded" },
    )
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* Effect.all(
      ids.map((id) => write(`${tmp.path}/order/${id}.txt`, `after-${id}`)),
      { concurrency: "unbounded" },
    )
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    expect((yield* snapshot.diffFull(before!, after!)).map((item) => item.file)).toEqual(
      ids.map((id) => `order/${id}.txt`),
    )
  }),
  { git: true },
)

it.instance(
  "diffFull with file modifications",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/b.txt`, "modified content")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(1)
      expect(diffs[0].file).toBe("b.txt")
      expect(diffs[0].patch).toContain(`-${tmp.extra.bContent}`)
      expect(diffs[0].patch).toContain("+modified content")
      expect(diffs[0].additions).toBeGreaterThan(0)
      expect(diffs[0].deletions).toBeGreaterThan(0)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with file deletions",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* rm(`${tmp.path}/a.txt`)
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(1)
      expect(diffs[0].file).toBe("a.txt")
      expect(diffs[0].patch).toContain(`-${tmp.extra.aContent}`)
      expect(diffs[0].additions).toBe(0)
      expect(diffs[0].deletions).toBe(1)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with multiple line additions",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/multi.txt`, "line1\nline2\nline3")
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(1)
      expect(diffs[0].file).toBe("multi.txt")
      expect(diffs[0].patch).toContain("+line1")
      expect(diffs[0].patch).toContain("+line3")
      expect(diffs[0].additions).toBe(3)
      expect(diffs[0].deletions).toBe(0)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with addition and deletion",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/added.txt`, "added content")
      yield* rm(`${tmp.path}/a.txt`)
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(2)
      const added = diffs.find((d) => d.file === "added.txt")!
      expect(added.patch).toContain("+added content")
      expect(added.additions).toBe(1)
      expect(added.deletions).toBe(0)
      const removed = diffs.find((d) => d.file === "a.txt")!
      expect(removed.patch).toContain(`-${tmp.extra.aContent}`)
      expect(removed.additions).toBe(0)
      expect(removed.deletions).toBe(1)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with multiple additions and deletions",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/multi1.txt`, "line1\nline2\nline3")
      yield* write(`${tmp.path}/multi2.txt`, "single line")
      yield* rm(`${tmp.path}/a.txt`)
      yield* rm(`${tmp.path}/b.txt`)
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(4)
      expect(diffs.find((d) => d.file === "multi1.txt")!.additions).toBe(3)
      expect(diffs.find((d) => d.file === "multi1.txt")!.deletions).toBe(0)
      expect(diffs.find((d) => d.file === "multi2.txt")!.additions).toBe(1)
      expect(diffs.find((d) => d.file === "multi2.txt")!.deletions).toBe(0)
      expect(diffs.find((d) => d.file === "a.txt")!.additions).toBe(0)
      expect(diffs.find((d) => d.file === "a.txt")!.deletions).toBe(1)
      expect(diffs.find((d) => d.file === "b.txt")!.additions).toBe(0)
      expect(diffs.find((d) => d.file === "b.txt")!.deletions).toBe(1)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with no changes",
  withTrackedSnapshot(({ snapshot, before }) =>
    Effect.gen(function* () {
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      expect((yield* snapshot.diffFull(before, after!)).length).toBe(0)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with binary file changes",
  withTrackedSnapshot(({ tmp, snapshot, before }) =>
    Effect.gen(function* () {
      yield* write(`${tmp.path}/binary.bin`, new Uint8Array([0x00, 0x01, 0x02, 0x03]))
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      const diffs = yield* snapshot.diffFull(before, after!)
      expect(diffs.length).toBe(1)
      expect(diffs[0].file).toBe("binary.bin")
      expect(diffs[0].patch).toBe("")
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull with whitespace changes",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/whitespace.txt`, "line1\nline2")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.path}/whitespace.txt`, "line1\n\nline2\n")
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()
    const diffs = yield* snapshot.diffFull(before!, after!)
    expect(diffs.length).toBe(1)
    expect(diffs[0].file).toBe("whitespace.txt")
    expect(diffs[0].additions).toBeGreaterThan(0)
  }),
  { git: true },
)

it.instance(
  "revert with overlapping files across patches uses first patch hash",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* write(`${tmp.path}/shared.txt`, "v1")
    const snap1 = yield* snapshot.track()
    expect(snap1).toBeTruthy()
    yield* write(`${tmp.path}/shared.txt`, "v2")
    const snap2 = yield* snapshot.track()
    expect(snap2).toBeTruthy()
    yield* write(`${tmp.path}/shared.txt`, "v3")
    const patch1 = yield* snapshot.patch(snap1!)
    const patch2 = yield* snapshot.patch(snap2!)
    expect(patch1.files).toContain(fwd(tmp.path, "shared.txt"))
    expect(patch2.files).toContain(fwd(tmp.path, "shared.txt"))
    yield* snapshot.revert([patch1, patch2])
    expect(yield* readText(`${tmp.path}/shared.txt`)).toBe("v1")
  }),
  { git: true },
)

it.instance(
  "revert preserves patch order when the same hash appears again",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    yield* mkdirp(`${tmp.path}/foo`)
    yield* write(`${tmp.path}/foo/bar`, "v1")
    yield* write(`${tmp.path}/a.txt`, "v1")
    const snap1 = yield* snapshot.track()
    expect(snap1).toBeTruthy()
    yield* rm(`${tmp.path}/foo`)
    yield* write(`${tmp.path}/foo`, "v2")
    yield* write(`${tmp.path}/a.txt`, "v2")
    const snap2 = yield* snapshot.track()
    expect(snap2).toBeTruthy()
    yield* rm(`${tmp.path}/foo`)
    yield* write(`${tmp.path}/a.txt`, "v3")
    yield* snapshot.revert([
      { hash: snap1!, files: [fwd(tmp.path, "a.txt")] },
      { hash: snap2!, files: [fwd(tmp.path, "foo")] },
      { hash: snap1!, files: [fwd(tmp.path, "foo", "bar")] },
    ])
    expect(yield* readText(`${tmp.path}/a.txt`)).toBe("v1")
    expect((yield* Effect.promise(() => fs.stat(`${tmp.path}/foo`))).isDirectory()).toBe(true)
    expect(yield* readText(`${tmp.path}/foo/bar`)).toBe("v1")
  }),
  { git: true },
)

it.instance(
  "revert handles large mixed batches across chunk boundaries",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const base = Array.from({ length: OVER_BATCH_COUNT }, (_, i) => fwd(tmp.path, "batch", `${i}.txt`))
    const fresh = [fwd(tmp.path, "fresh", "0.txt")]
    yield* mkdirp(`${tmp.path}/batch`)
    yield* mkdirp(`${tmp.path}/fresh`)
    yield* Effect.all(
      base.map((file, i) => write(file, `base-${i}`)),
      { concurrency: "unbounded" },
    )
    const snap = yield* snapshot.track()
    expect(snap).toBeTruthy()
    yield* Effect.all(
      [...base.map((file, i) => write(file, `next-${i}`)), ...fresh.map((file, i) => write(file, `fresh-${i}`))],
      { concurrency: "unbounded" },
    )
    const patch = yield* snapshot.patch(snap!)
    expect(patch.files.length).toBe(base.length + fresh.length)
    yield* snapshot.revert([patch])
    for (let i = 0; i < base.length; i++) expect(yield* readText(base[i])).toBe(`base-${i}`)
    for (const file of fresh) expect(yield* exists(file)).toBe(false)
  }),
  { git: true },
)
