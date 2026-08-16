import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Fff } from "@opencode-ai/core/filesystem/fff.bun"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))
const search = testEffect(LayerNode.compile(FSUtil.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

describe("FileSystemSearch", () => {
  search.effect("initializes one shared fff picker on the first search", () =>
    Effect.gen(function* () {
      const calls = { create: 0, destroy: 0 }
      const options: Fff.Init[] = []
      const create: typeof Fff.create = (input) => {
        calls.create++
        options.push(input)
        return {
          ok: true,
          value: {
            destroy: () => calls.destroy++,
            isScanning: () => false,
            waitForScan: async () => ({ ok: true, value: true }),
            refreshGitStatus: () => ({ ok: true, value: 0 }),
            fileSearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }),
            glob: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }),
            directorySearch: () => ({
              ok: true,
              value: { items: [], scores: [], totalMatched: 0, totalDirs: 0 },
            }),
            mixedSearch: () => ({
              ok: true,
              value: { items: [], scores: [], totalMatched: 0, totalFiles: 0, totalDirs: 0 },
            }),
            grep: () => ({
              ok: true,
              value: {
                items: [],
                totalMatched: 0,
                totalFilesSearched: 0,
                totalFiles: 0,
                filteredFileCount: 0,
                nextCursor: null,
              },
            }),
            trackQuery: () => ({ ok: true, value: true }),
            getHistoricalQuery: () => ({ ok: true, value: null }),
          },
        }
      }
      const { FileSystemSearch } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem/search"))
      const directory = AbsolutePath.make("/tmp/search-fff")
      yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(
              FileSystemSearch.makeFffLayer(create).pipe(
                Layer.provide(
                  Layer.succeed(Location.Service, Location.Service.of(location(Location.Ref.make({ directory })))),
                ),
              ),
              scope,
            )
            const service = Context.get(context, FileSystemSearch.Service)
            expect(calls.create).toBe(0)

            yield* Effect.all(
              [
                service.find({ query: "", type: "file", limit: 1 }),
                service.glob({ pattern: "**/*.ts", limit: 1 }),
                service.grep({ pattern: "needle", limit: 1 }),
              ],
              { concurrency: "unbounded" },
            )
            expect(calls.create).toBe(1)
            expect(options).toEqual([
              {
                basePath: directory,
                aiMode: true,
                disableMmapCache: true,
                disableContentIndexing: true,
              },
            ])

            yield* service.find({ query: "", type: "file", limit: 1 })
            expect(calls.create).toBe(1)
            expect(calls.destroy).toBe(0)
          }),
        (scope, exit) => Scope.close(scope, exit),
      )
      expect(calls.destroy).toBe(1)
    }),
  )

  search.effect("caches a failed fff initialization across searches", () =>
    Effect.gen(function* () {
      const calls = { create: 0, destroy: 0 }
      const create: typeof Fff.create = () => {
        calls.create++
        return { ok: false, error: "fff unavailable" }
      }
      const { FileSystemSearch } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem/search"))
      const directory = AbsolutePath.make("/tmp/search-fff-error")
      yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(
              FileSystemSearch.makeFffLayer(create).pipe(
                Layer.provide(
                  Layer.succeed(Location.Service, Location.Service.of(location(Location.Ref.make({ directory })))),
                ),
              ),
              scope,
            )
            const service = Context.get(context, FileSystemSearch.Service)
            expect(calls.create).toBe(0)

            const results = yield* Effect.all(
              [
                service.find({ query: "", type: "file", limit: 1 }),
                service.glob({ pattern: "**/*.ts", limit: 1 }),
                service.grep({ pattern: "needle", limit: 1 }),
              ],
              { concurrency: "unbounded" },
            )
            expect(results).toEqual([[], [], []])
            expect(calls.create).toBe(1)

            expect(yield* service.find({ query: "", type: "file", limit: 1 })).toEqual([])
            expect(calls.create).toBe(1)
            expect(calls.destroy).toBe(0)
          }),
        (scope, exit) => Scope.close(scope, exit),
      )
      expect(calls.destroy).toBe(0)
    }),
  )

  search.effect("collects fallback directories incrementally without duplicates", () =>
    Effect.gen(function* () {
      const count = 4_000
      const halfway = Deferred.makeUnsafe<void>()
      const resume = Deferred.makeUnsafe<void>()
      const complete = Deferred.makeUnsafe<void>()
      const entries = Array.from({ length: count }, (_, index) =>
        FileSystem.Entry.make({
          path: RelativePath.make(`group-${Math.floor(index / 2)}/nested/file-${index}.txt`),
          type: "file",
        }),
      )
      const directories = Array.from({ length: count / 2 }, (_, index) => [
        RelativePath.make(`group-${index}${path.sep}`),
        RelativePath.make(`group-${index}/nested${path.sep}`),
      ]).flat()
      const ripgrep = Ripgrep.Service.of({
        find: (input) =>
          Effect.gen(function* () {
            yield* Effect.forEach(entries.slice(0, count / 2), (entry) => input.onEntry?.(entry) ?? Effect.void, {
              discard: true,
            })
            yield* Deferred.succeed(halfway, undefined)
            yield* Deferred.await(resume)
            yield* Effect.forEach(entries.slice(count / 2), (entry) => input.onEntry?.(entry) ?? Effect.void, {
              discard: true,
            })
            yield* Deferred.succeed(complete, undefined)
            return entries
          }),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
      })
      const filesystem = yield* FSUtil.Service
      const directory = AbsolutePath.make("/tmp/search-fallback")
      const { FileSystemSearch } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem/search"))
      yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(
              FileSystemSearch.ripgrepLayer.pipe(
                Layer.provide(Layer.succeed(FSUtil.Service, filesystem)),
                Layer.provide(
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(
                      location(Location.Ref.make({ directory }), {
                        vcs: { type: "git", store: AbsolutePath.make(path.join(directory, ".git")) },
                      }),
                    ),
                  ),
                ),
                Layer.provide(Layer.succeed(Ripgrep.Service, ripgrep)),
              ),
              scope,
            )
            const service = Context.get(context, FileSystemSearch.Service)
            yield* Deferred.await(halfway)

            const partial = yield* service.find({ query: "group", type: "directory", limit: count })
            expect(partial).toHaveLength(count / 2)
            expect(new Set(partial.map((entry) => entry.path))).toEqual(new Set(directories.slice(0, count / 2)))

            yield* Deferred.succeed(resume, undefined)
            yield* Deferred.await(complete)
            const result = yield* service.find({ query: "group", type: "directory", limit: count })
            expect(result).toHaveLength(count)
            expect(new Set(result.map((entry) => entry.path))).toEqual(new Set(directories))
          }),
        (scope, exit) => Scope.close(scope, exit),
      )
    }),
  )
})
