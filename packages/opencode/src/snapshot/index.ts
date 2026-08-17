import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"
import { StructuredFileDiff } from "@opencode-ai/core/tool/structured-file-diff"
import { JsonString } from "@opencode-ai/core/util/json-string"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

type DiffPin = {
  sessionID: string
  messageID: string
}

const prune = "7.days"
const limit = 2 * 1024 * 1024
const diffLineLimit = 128 * 1024
// Full-context patches are optional review payloads, so stop Myers before dense edits can monopolize the runtime.
const diffTimeout = 250
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string, to?: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly sessionPreviewDiff: (hash: string) => Effect.Effect<string | undefined>
  readonly pinDiff: (input: DiffPin & { from: string; to: string }) => Effect.Effect<boolean>
  readonly copyDiffPin: (input: { from: DiffPin; to: DiffPin }) => Effect.Effect<boolean>
  readonly unpinDiff: (input: DiffPin) => Effect.Effect<void>
  readonly unpinSessionDiffs: (sessionID: string) => Effect.Effect<void>
  readonly diffSummary: (from: string, to: string) => Effect.Effect<FileDiff[] | undefined>
  readonly diffFullAvailable: (from: string, to: string) => Effect.Effect<FileDiff[] | undefined>
  readonly diffPinned: (
    input: DiffPin & { readonly from?: string; readonly to?: string; readonly excludeTo?: string },
  ) => Effect.Effect<FileDiff[] | undefined>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const diffRefs = (input: DiffPin) => {
          const base = `refs/opencode/session-diffs/${Hash.fast(input.sessionID)}/${Hash.fast(input.messageID)}`
          return { base, from: `${base}/from`, to: `${base}/to` }
        }

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (
            cmd: string[],
            opts?: {
              cwd?: string
              env?: Record<string, string>
              stdin?: string
              maxOutputBytes?: number
              maxErrorBytes?: number
              timeout?: Duration.Input
              forceKillAfter?: Duration.Input
            },
          ) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, {
                cwd: opts?.cwd,
                env: opts?.env,
                extendEnv: true,
                forceKillAfter: opts?.forceKillAfter,
              }),
              {
                stdin: opts?.stdin,
                maxOutputBytes: opts?.maxOutputBytes,
                maxErrorBytes: opts?.maxErrorBytes,
                timeout: opts?.timeout,
              },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
              stdoutTruncated: result.stdoutTruncated,
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
              stdoutTruncated: false,
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const excludeFile = yield* Effect.cached(excludes())
        let synced: string | undefined

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludeFile
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          const content = text ? `${text}\n` : ""
          if (content === synced) return
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, content).pipe(Effect.orDie)
          synced = content
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const trackUnlocked = Effect.fnUntraced(function* () {
          if (!(yield* enabled())) return
          const existed = yield* exists(state.gitdir)
          yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
          if (!existed) {
            yield* git(["init"], {
              env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
            })
            yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
            yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
            // Tuning for very large worktrees so the first add stays bounded.
            yield* git(["--git-dir", state.gitdir, "config", "feature.manyFiles", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "index.version", "4"])
            yield* git(["--git-dir", state.gitdir, "config", "index.threads", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"])
            yield* seed()
            yield* Effect.logInfo("initialized")
          }
          yield* add()
          const result = yield* git(args(["write-tree"]), { cwd: state.directory })
          const hash = result.text.trim()
          yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
          return hash
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(trackUnlocked())
        })

        const patch = Effect.fnUntraced(function* (hash: string, to?: string) {
          return yield* locked(
            Effect.gen(function* () {
              if (!to) yield* add()
              const result = yield* git(
                [
                  ...quote,
                  ...args([
                    "diff",
                    ...(to ? [] : ["--cached"]),
                    "--no-ext-diff",
                    "--name-only",
                    hash,
                    ...(to ? [to] : []),
                    "--",
                    ".",
                  ]),
                ],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const sessionPreviewDiff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
                // Git appends a newline that trim removes before the serialized-size check.
                maxOutputBytes: StructuredFileDiff.MAX_PATCH_BYTES + 1,
                maxErrorBytes: 16 * 1024,
                timeout: Duration.seconds(5),
                forceKillAfter: Duration.seconds(1),
              })
              if (result.code !== 0 || result.stdoutTruncated) return
              const value = result.text.trim()
              if (JsonString.bytesUpTo(value, StructuredFileDiff.MAX_PATCH_BYTES) > StructuredFileDiff.MAX_PATCH_BYTES)
                return
              return value
            }),
          )
        })

        type Row = {
          file: string
          status: "added" | "deleted" | "modified"
          binary: boolean
          additions: number
          deletions: number
        }

        const diffRows = Effect.fnUntraced(function* (from: string, to: string) {
          const status = new Map<string, "added" | "deleted" | "modified">()
          const statuses = yield* git(
            [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
            { cwd: state.directory },
          )
          if (statuses.code !== 0) return { available: false as const, rows: [] }

          for (const line of statuses.text.trim().split("\n")) {
            if (!line) continue
            const [code, file] = line.split("\t")
            if (!code || !file) continue
            status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
          }

          const numstat = yield* git(
            [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
            { cwd: state.directory },
          )
          if (numstat.code !== 0) return { available: false as const, rows: [] }
          const rows = numstat.text
            .trim()
            .split("\n")
            .filter(Boolean)
            .flatMap((line) => {
              const [adds, dels, file] = line.split("\t")
              if (!file) return []
              const binary = adds === "-" && dels === "-"
              const additions = binary ? 0 : parseInt(adds)
              const deletions = binary ? 0 : parseInt(dels)
              return [
                {
                  file,
                  status: status.get(file) ?? "modified",
                  binary,
                  additions: Number.isFinite(additions) ? additions : 0,
                  deletions: Number.isFinite(deletions) ? deletions : 0,
                } satisfies Row,
              ]
            })

          const ignored = yield* ignore(rows.map((row) => row.file))
          if (!ignored.size) return { available: true as const, rows }
          return { available: true as const, rows: rows.filter((row) => !ignored.has(row.file)) }
        })

        const diffSummary = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            diffRows(from, to).pipe(
              Effect.map((result) =>
                result.available
                  ? result.rows.map((row) => ({
                      file: row.file,
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    }))
                  : undefined,
              ),
            ),
          )
        })

        const diffFullAvailable = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const needsContent = (row: Row) => !row.binary && (row.additions !== 0 || row.deletions !== 0)
              const refs = (rows: readonly Row[]) =>
                rows.flatMap((row) => {
                  if (!needsContent(row)) return []
                  if (row.status === "added")
                    return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                  if (row.status === "deleted")
                    return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                  return [
                    { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                    { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                  ]
                })

              const inspect = Effect.fnUntraced(function* (rows: readonly Row[]) {
                const list = refs(rows)
                if (!list.length) return new Map<string, { before?: number; after?: number }>()
                const batch = yield* git(
                  [...cfg, ...args(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"])],
                  {
                    cwd: state.directory,
                    stdin: list.map((item) => item.ref).join("\n") + "\n",
                  },
                )
                if (batch.code !== 0) return
                const lines = (batch.text.endsWith("\n") ? batch.text.slice(0, -1) : batch.text).split("\n")
                if (lines.length !== list.length) return

                const map = new Map<string, { before?: number; after?: number }>()
                for (let i = 0; i < list.length; i++) {
                  const match = lines[i]?.match(/^[0-9a-f]+ blob (\d+)$/)
                  if (!match) return
                  const size = Number(match[1])
                  if (!Number.isSafeInteger(size) || size < 0) return
                  const ref = list[i]!
                  const hit = map.get(ref.file) ?? {}
                  hit[ref.side] = size
                  map.set(ref.file, hit)
                }
                return map
              })

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const list = refs(rows)
                  if (!list.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    { stdin: list.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: list.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of list) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const source = yield* diffRows(from, to)
              if (!source.available) return
              const rows = source.rows
              const metadata = (row: Row): FileDiff => ({
                file: row.file,
                additions: row.additions,
                deletions: row.deletions,
                status: row.status,
              })

              let changedLines = 0
              for (const row of rows) {
                const lines = row.additions + row.deletions
                if (lines > diffLineLimit - changedLines) return rows.map(metadata)
                changedLines += lines
              }

              const sizes = yield* inspect(rows)
              if (!sizes) return rows.map(metadata)
              let contentBytes = 0
              for (const row of rows) {
                if (!needsContent(row)) continue
                const hit = sizes.get(row.file)
                const before = row.status === "added" ? 0 : hit?.before
                const after = row.status === "deleted" ? 0 : hit?.after
                if (before === undefined || after === undefined) return rows.map(metadata)
                const size = Math.max(before, after)
                if (size > StructuredFileDiff.MAX_PATCH_BYTES - contentBytes) return rows.map(metadata)
                contentBytes += size
              }

              const step = 100
              let remainingDiffTime = diffTimeout
              const patch = (file: string, before: string, after: string) => {
                if (remainingDiffTime <= 0) return
                const start = performance.now()
                const value = structuredPatch(file, file, before, after, "", "", {
                  context: Number.MAX_SAFE_INTEGER,
                  timeout: remainingDiffTime,
                })
                const result = value ? formatPatch(value) : undefined
                remainingDiffTime -= performance.now() - start
                return result
              }
              const lineTokens = (value: string) => {
                if (!value) return 0
                let count = value.endsWith("\n") ? 0 : 1
                for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) count++
                return count
              }
              let remainingPatchBytes = StructuredFileDiff.MAX_PATCH_BYTES
              let remainingLineTokens = diffLineLimit
              let overflow = false

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                if (overflow) {
                  result.push(...run.map(metadata))
                  continue
                }
                const text = yield* load(run)

                for (const row of run) {
                  if (overflow) {
                    result.push(metadata(row))
                    continue
                  }
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = needsContent(row)
                    ? text
                      ? [hit.before, hit.after]
                      : yield* show(row)
                    : ["", ""]
                  const tokens = lineTokens(before) + lineTokens(after)
                  if (tokens > remainingLineTokens) {
                    overflow = true
                    result.push(metadata(row))
                    continue
                  }
                  remainingLineTokens -= tokens
                  const value = row.binary ? "" : patch(row.file, before, after)
                  if (value === undefined) {
                    overflow = true
                    result.push(metadata(row))
                    continue
                  }
                  const bytes = JsonString.bytesUpTo(value, remainingPatchBytes)
                  if (bytes > remainingPatchBytes) {
                    overflow = true
                    result.push(metadata(row))
                    continue
                  }
                  remainingPatchBytes -= bytes
                  result.push({
                    file: row.file,
                    patch: value,
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return overflow ? rows.map(metadata) : result
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return (yield* diffFullAvailable(from, to)) ?? []
        })

        const pinUnlocked = Effect.fnUntraced(function* (input: DiffPin & { from: string; to: string }) {
          if (!(yield* enabled())) return false
          const refs = diffRefs(input)
          const result = yield* git(["--git-dir", state.gitdir, "update-ref", "--stdin"], {
            cwd: state.directory,
            stdin: `start\nupdate ${refs.from} ${input.from}\nupdate ${refs.to} ${input.to}\nprepare\ncommit\n`,
          })
          if (result.code === 0) return true
          yield* Effect.logWarning("failed to pin session diff snapshots", {
            sessionID: input.sessionID,
            messageID: input.messageID,
            stderr: result.stderr,
          })
          return false
        })

        const pinDiff = Effect.fnUntraced(function* (input: DiffPin & { from: string; to: string }) {
          return yield* locked(pinUnlocked(input))
        })

        const copyDiffPin = Effect.fnUntraced(function* (input: { from: DiffPin; to: DiffPin }) {
          return yield* locked(
            Effect.gen(function* () {
              const refs = diffRefs(input.from)
              const hashes = yield* Effect.all(
                [refs.from, refs.to].map((ref) => git(["--git-dir", state.gitdir, "rev-parse", "--verify", ref])),
                { concurrency: 2 },
              )
              if (hashes.some((result) => result.code !== 0)) return false
              return yield* pinUnlocked({
                ...input.to,
                from: hashes[0]!.text.trim(),
                to: hashes[1]!.text.trim(),
              })
            }),
          )
        })

        const unpinDiff = Effect.fnUntraced(function* (input: DiffPin) {
          const refs = diffRefs(input)
          yield* locked(
            git(["--git-dir", state.gitdir, "update-ref", "--stdin"], {
              cwd: state.directory,
              stdin: `start\ndelete ${refs.from}\ndelete ${refs.to}\nprepare\ncommit\n`,
            }).pipe(Effect.asVoid),
          )
        })

        const unpinSessionDiffs = Effect.fnUntraced(function* (sessionID: string) {
          yield* locked(
            Effect.gen(function* () {
              const prefix = `refs/opencode/session-diffs/${Hash.fast(sessionID)}/`
              const listed = yield* git(["--git-dir", state.gitdir, "for-each-ref", "--format=%(refname)", prefix])
              if (listed.code !== 0) return
              const refs = listed.text.trim().split("\n").filter(Boolean)
              if (!refs.length) return
              yield* git(["--git-dir", state.gitdir, "update-ref", "--stdin"], {
                stdin: refs.map((ref) => `delete ${ref}`).join("\n") + "\n",
              })
            }),
          )
        })

        const diffPinned = Effect.fnUntraced(function* (
          input: DiffPin & { readonly from?: string; readonly to?: string; readonly excludeTo?: string },
        ) {
          const refs = diffRefs(input)
          if (input.from !== undefined || input.to !== undefined || input.excludeTo !== undefined) {
            if ((input.from === undefined) !== (input.to === undefined)) return
            const result = yield* git(["--git-dir", state.gitdir, "rev-parse", refs.from, refs.to], {
              cwd: state.directory,
            })
            if (result.code !== 0) return
            const [from, to] = result.text.trim().split("\n")
            if (input.from !== undefined && (from !== input.from || to !== input.to)) return
            if (to === input.excludeTo) return
          }
          return yield* diffFullAvailable(refs.from, refs.to)
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return {
          cleanup,
          track,
          patch,
          restore,
          revert,
          diff,
          sessionPreviewDiff,
          pinDiff,
          copyDiffPin,
          unpinDiff,
          unpinSessionDiffs,
          diffSummary,
          diffFullAvailable,
          diffPinned,
          diffFull,
        }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string, to?: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash, to))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      sessionPreviewDiff: Effect.fn("Snapshot.sessionPreviewDiff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.sessionPreviewDiff(hash))
      }),
      pinDiff: Effect.fn("Snapshot.pinDiff")(function* (input: DiffPin & { from: string; to: string }) {
        return yield* InstanceState.useEffect(state, (s) => s.pinDiff(input))
      }),
      copyDiffPin: Effect.fn("Snapshot.copyDiffPin")(function* (input: { from: DiffPin; to: DiffPin }) {
        return yield* InstanceState.useEffect(state, (s) => s.copyDiffPin(input))
      }),
      unpinDiff: Effect.fn("Snapshot.unpinDiff")(function* (input: DiffPin) {
        return yield* InstanceState.useEffect(state, (s) => s.unpinDiff(input))
      }),
      unpinSessionDiffs: Effect.fn("Snapshot.unpinSessionDiffs")(function* (sessionID: string) {
        return yield* InstanceState.useEffect(state, (s) => s.unpinSessionDiffs(sessionID))
      }),
      diffSummary: Effect.fn("Snapshot.diffSummary")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffSummary(from, to))
      }),
      diffFullAvailable: Effect.fn("Snapshot.diffFullAvailable")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFullAvailable(from, to))
      }),
      diffPinned: Effect.fn("Snapshot.diffPinned")(function* (
        input: DiffPin & { readonly from?: string; readonly to?: string; readonly excludeTo?: string },
      ) {
        return yield* InstanceState.useEffect(state, (s) => s.diffPinned(input))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."
