import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { filesystem, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Clock, Duration, Effect, FileSystem, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import {
  InstallationChannel,
  InstallationUpdateChannel,
  InstallationUpdateRepository,
  InstallationVersion,
} from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export function isNewer(current: string, latest: string) {
  if (!semver.valid(current) || !semver.valid(latest)) return false
  return semver.gt(latest, current)
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export function isPatched() {
  return InstallationUpdateChannel === "patched"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const GitHubPrerelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
})
const GitHubPrereleases = Schema.Array(GitHubPrerelease)
type GitHubPrerelease = Schema.Schema.Type<typeof GitHubPrerelease>
const GitHubPrereleaseCache = Schema.Struct({
  repository: Schema.String,
  channel: Schema.Literal("patched"),
  checked_at: Schema.Number,
  releases: GitHubPrereleases,
})
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

const PATCHED_RELEASE = /^v?(\d+\.\d+\.\d+-patched\.\d+)$/
const UPDATE_CACHE_TTL = 60 * 60 * 1000

export function selectPatchedRelease(releases: ReadonlyArray<GitHubPrerelease>, asset = patchedAssetName()) {
  if (!asset) return undefined
  return releases
    .filter((release) => !release.draft && release.prerelease)
    .filter((release) => PATCHED_RELEASE.test(release.tag_name))
    .filter((release) => release.assets.some((item) => item.name === asset))
    .filter((release) => release.assets.some((item) => item.name === `${asset}.sha256`))
    .sort((a, b) => semver.rcompare(normalizePatchedVersion(a.tag_name), normalizePatchedVersion(b.tag_name)))[0]
}

function normalizePatchedVersion(tag: string) {
  return tag.match(PATCHED_RELEASE)?.[1] ?? tag.replace(/^v/, "")
}

function patchedAssetName() {
  if (process.platform !== "linux" || process.arch !== "x64") return undefined
  return "opencode-linux-x64"
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method, refresh?: boolean) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service | FileSystem.FileSystem> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service
    const fs = yield* FileSystem.FileSystem
    const prereleaseCache = path.join(Global.Path.cache, "update-prereleases.json")

    // Self-update runs execute installers / version checks, which can legitimately
    // take a while on slow networks or hung package managers. Bound them anyway so
    // an indefinite hang cannot wedge the upgrade path, and cap output to avoid
    // unbounded buffering of installer noise.
    const installTimeout = Duration.minutes(10)
    const installMaxOutputBytes = 1024 * 1024
    const installMaxErrorBytes = 1024 * 1024

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
          {
            timeout: installTimeout,
            maxOutputBytes: installMaxOutputBytes,
            maxErrorBytes: installMaxErrorBytes,
          },
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
          {
            timeout: installTimeout,
            maxOutputBytes: installMaxOutputBytes,
            maxErrorBytes: installMaxErrorBytes,
          },
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
      if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
      const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
      if (coreFormula.includes("opencode")) return "opencode"
      return "opencode"
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(HttpClientRequest.get("https://opencode.ai/install"))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
          {
            timeout: installTimeout,
            maxOutputBytes: installMaxOutputBytes,
            maxErrorBytes: installMaxErrorBytes,
          },
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const readPrereleaseCache = fs.readFileString(prereleaseCache).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubPrereleaseCache))),
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const fetchPatchedReleases = Effect.fnUntraced(function* () {
      const response = yield* httpOk.execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${InstallationUpdateRepository}/releases?per_page=30`,
        ).pipe(HttpClientRequest.acceptJson),
      )
      return yield* HttpClientResponse.schemaBodyJson(GitHubPrereleases)(response)
    })

    const patchedReleases = Effect.fnUntraced(function* (refresh = false) {
      const now = yield* Clock.currentTimeMillis
      const cached = yield* readPrereleaseCache
      if (
        !refresh &&
        cached?.repository === InstallationUpdateRepository &&
        now - cached.checked_at < UPDATE_CACHE_TTL
      ) {
        return cached.releases
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`installation-release:${InstallationUpdateRepository}`)
          const checkedAt = yield* Clock.currentTimeMillis
          const lockedCache = yield* readPrereleaseCache
          if (
            !refresh &&
            lockedCache?.repository === InstallationUpdateRepository &&
            checkedAt - lockedCache.checked_at < UPDATE_CACHE_TTL
          ) {
            return lockedCache.releases
          }

          const releases = yield* fetchPatchedReleases().pipe(
            Effect.catch((error) => {
              if (!refresh && lockedCache?.repository === InstallationUpdateRepository) {
                return Effect.succeed(lockedCache.releases)
              }
              return Effect.fail(error)
            }),
          )
          const temporary = `${prereleaseCache}.${process.pid}.${checkedAt}.tmp`
          yield* fs
            .writeFileString(
              temporary,
              JSON.stringify({
                repository: InstallationUpdateRepository,
                channel: "patched",
                checked_at: checkedAt,
                releases,
              }),
              { mode: 0o600 },
            )
            .pipe(
              Effect.andThen(fs.rename(temporary, prereleaseCache)),
              Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
              Effect.ignore,
            )
          return releases
        }),
      )
    })

    const upgradePatched = Effect.fnUntraced(
      function* (target: string) {
        const asset = patchedAssetName()
        if (!asset) return yield* new UpgradeFailedError({ stderr: "Patched updates only support Linux x64." })
        const normalizedTarget = normalizePatchedVersion(target)
        if (!PATCHED_RELEASE.test(normalizedTarget)) {
          return yield* new UpgradeFailedError({ stderr: "Invalid patched release version." })
        }

        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Flock.effect(`installation-upgrade:${process.execPath}`)

            const installed = yield* run([process.execPath, "--version"])
            const installedVersion = installed.stdout.trim().replace(/^v/, "")
            if (semver.valid(installedVersion) && semver.gte(installedVersion, normalizedTarget)) return

            const releases = yield* patchedReleases(true)
            const release = yield* Effect.fromNullishOr(
              releases.find(
                (item) => normalizePatchedVersion(item.tag_name) === normalizedTarget && selectPatchedRelease([item]),
              ),
            ).pipe(
              Effect.mapError(
                () => new UpgradeFailedError({ stderr: "Patched release assets were not found." }),
              ),
            )

            const binary = yield* Effect.fromNullishOr(release.assets.find((item) => item.name === asset)).pipe(
              Effect.mapError(() => new UpgradeFailedError({ stderr: "Patched release assets were incomplete." })),
            )
            const checksum = yield* Effect.fromNullishOr(
              release.assets.find((item) => item.name === `${asset}.sha256`),
            ).pipe(
              Effect.mapError(() => new UpgradeFailedError({ stderr: "Patched release assets were incomplete." })),
            )

            const checksumResponse = yield* httpOk.execute(HttpClientRequest.get(checksum.browser_download_url))
            const expected = yield* Effect.fromNullishOr(
              (yield* checksumResponse.text).match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase(),
            ).pipe(
              Effect.mapError(() => new UpgradeFailedError({ stderr: "Patched release checksum was invalid." })),
            )

            const temporary = `${process.execPath}.update-${process.pid}-${yield* Clock.currentTimeMillis}`
            yield* Effect.gen(function* () {
              const binaryResponse = yield* httpOk.execute(HttpClientRequest.get(binary.browser_download_url))
              yield* Stream.run(binaryResponse.stream, fs.sink(temporary, { flag: "wx", mode: 0o700 }))

              const hasher = new Bun.CryptoHasher("sha256")
              yield* Stream.runForEach(fs.stream(temporary), (chunk) =>
                Effect.sync(() => {
                  hasher.update(chunk)
                }),
              )
              if (hasher.digest("hex") !== expected) {
                yield* new UpgradeFailedError({ stderr: "Patched release checksum verification failed." })
              }

              yield* fs.chmod(temporary, 0o755)
              const smoke = yield* run([temporary, "--version"])
              if (smoke.code !== 0 || smoke.stdout.trim().replace(/^v/, "") !== normalizedTarget) {
                yield* new UpgradeFailedError({ stderr: "Patched release binary verification failed." })
              }
              yield* fs.rename(temporary, process.execPath)
            }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
          }),
        )
      },
      Effect.mapError((error) =>
        error instanceof UpgradeFailedError
          ? error
          : new UpgradeFailedError({ stderr: "Patched release upgrade failed." }),
      ),
    )

    const upgradeStandard = Effect.fnUntraced(function* (m: Method, target: string) {
      let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
      switch (m) {
        case "curl":
          upgradeResult = yield* upgradeCurl(target)
          break
        case "npm":
          upgradeResult = yield* run(["npm", "install", "-g", `opencode-ai@${target}`])
          break
        case "pnpm":
          upgradeResult = yield* run(["pnpm", "install", "-g", `opencode-ai@${target}`])
          break
        case "bun":
          upgradeResult = yield* run(["bun", "install", "-g", `opencode-ai@${target}`])
          break
        case "brew": {
          const formula = yield* getBrewFormula()
          const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
          if (formula.includes("/")) {
            const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
            if (tap.code !== 0) {
              upgradeResult = tap
              break
            }
            const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
            const dir = repo.trim()
            if (dir) {
              const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
              if (pull.code !== 0) {
                upgradeResult = pull
                break
              }
            }
          }
          upgradeResult = yield* run(["brew", "upgrade", formula], { env })
          break
        }
        case "choco":
          upgradeResult = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
          break
        case "scoop":
          upgradeResult = yield* run(["scoop", "install", `opencode@${target}`])
          break
        default:
          yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
      }
      const completed = yield* Effect.fromNullishOr(upgradeResult).pipe(
        Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure(m) })),
      )
      if (completed.code !== 0) yield* new UpgradeFailedError({ stderr: upgradeFailure(m, completed) })
      yield* Effect.logInfo("upgraded", {
        method: m,
        target,
        stdout: completed.stdout,
        stderr: completed.stderr,
      })
      yield* text([process.execPath, "--version"])
    })

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (InstallationUpdateChannel === "patched") return "curl" as Method
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
          { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "opencode" : "opencode-ai"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method, refresh = false) {
        if (InstallationUpdateChannel === "patched") {
          const release = selectPatchedRelease(yield* patchedReleases(refresh))
          if (!release) return yield* Effect.die("No compatible patched release found")
          return normalizePatchedVersion(release.tag_name)
        }

        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/opencode-ai/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        const response = yield* httpOk.execute(
          HttpClientRequest.get(
            `https://api.github.com/repos/${InstallationUpdateRepository}/releases/latest`,
          ).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        yield* (InstallationUpdateChannel === "patched" ? upgradePatched(target) : upgradeStandard(m, target))
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, filesystem, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
