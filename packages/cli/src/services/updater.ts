import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import {
  OPENCODE_ARTIFACT,
  OPENCODE_CHANNEL,
  OPENCODE_FORK,
  OPENCODE_LOCAL,
  OPENCODE_UPDATE_CHANNEL,
  OPENCODE_UPDATE_REPOSITORY,
  OPENCODE_VERSION,
} from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import semver from "semver"
import { stripVTControlCharacters } from "node:util"
import { RetainedImage } from "./retained-image"
import {
  action,
  canUpgradeToTarget,
  forkAssetName,
  isForkRelease,
  normalizeForkVersion,
  parseReleaseVersion,
  selectForkRelease,
  type ForkRelease,
  type Policy,
} from "./updater-action"
import { errorMessage } from "../util/error"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew"] as const

export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title: string
  readonly detail: string
  readonly command?: string
  readonly retry: string

  constructor(
    input: {
      readonly title: string
      readonly detail: string
      readonly command?: string
      readonly retry: string
    },
    options?: ErrorOptions,
  ) {
    super(input.detail, options)
    this.name = "UpgradeError"
    this.title = input.title
    this.detail = input.detail
    this.command = input.command
    this.retry = input.retry
  }
}

const decodeVpPackages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
)

const installNames: Record<Method, string> = {
  curl: "The OpenCode installer",
  npm: "npm",
  pnpm: "pnpm",
  bun: "Bun",
  yarn: "Yarn",
  vp: "Vite+",
  brew: "Homebrew",
}

function conciseDetail(input: string) {
  const lines = stripVTControlCharacters(input)
    .trim()
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const tail = lines.slice(-12).join("\n")
  const clipped = tail.length > 2_000
  const detail = clipped ? `…${tail.slice(-1_999)}` : tail
  if (!detail) return
  if (lines.length <= 12 && !clipped) return detail
  return `${detail}\n\nOutput shortened to the last 12 lines.`
}

function errorDetail(cause: unknown): string {
  if (cause instanceof AppProcess.AppProcessError) {
    const stderr = conciseDetail(cause.stderr ?? "")
    if (stderr) return stderr
    if (cause.cause !== undefined) return errorDetail(cause.cause)
    return cause.message
  }
  if (cause instanceof Error) {
    const detail = cause.cause === undefined ? undefined : errorDetail(cause.cause)
    if (!detail || detail === cause.message) return cause.message
    return `${cause.message}: ${detail}`
  }
  return errorMessage(cause)
}

function resultDetail(result: { code: number; stdout: string; stderr: string }) {
  return (
    conciseDetail(result.stderr) ??
    conciseDetail(result.stdout) ??
    `The command exited with code ${result.code} without any error output.`
  )
}

export interface Interface {
  readonly run: (onInstall?: (version: string) => void) => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: (method?: Method) => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (
    method: Method,
  ) => { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> } | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const ForkReleaseList = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
      }),
    ),
  }),
)

const decodeForkReleases = Schema.decodeUnknownOption(Schema.fromJsonString(ForkReleaseList))

/** `opencode v1.2.3` on stdout, as `--version` prints it. */
function reportedVersion(output: string) {
  return output
    .trim()
    .replace(/^opencode\s+/, "")
    .replace(/^v/, "")
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
  // A fork build is recognised by its channel and by its version marker. Either one alone
  // is enough to keep the official release service from touching this binary.
  const fork = OPENCODE_FORK || isForkRelease(OPENCODE_VERSION)
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  const installedPackage = yield* Effect.gen(function* () {
    const directory = path.dirname(path.dirname(executable))
    const manifest: { name: string; bin?: Record<string, string> } = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text))))
    // Source invocations run inside Bun or Node, which may themselves be npm packages.
    if (!/^@opencode(?:-ai)?\/cli(?:-node)?$/.test(manifest.name)) return
    if (Object.values(manifest.bin ?? {}).some((bin) => path.resolve(directory, bin) === executable))
      return manifest.name
  }).pipe(Effect.orElseSucceed(() => undefined))
  // "opencode" is Homebrew Core's formula; the others are published to anomalyco/tap.
  const installedFormula = ["opencode", "opencode-beta", "opencode-v2"].find((name) =>
    executable.includes(`${path.sep}Cellar${path.sep}${name}${path.sep}`),
  )

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "10 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
      )
  })

  const curlBinary = path.resolve(
    global.home,
    ".opencode",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  )

  // On Windows a bare `bash` may be the WSL launcher, which cannot run the installer against Windows paths.
  const installerBash = Effect.fnUntraced(function* () {
    if (process.platform !== "win32") return "bash"
    if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH
    const git = yield* exec(["git", "--exec-path"]).pipe(Effect.orElseSucceed(() => undefined))
    const bash = git?.code === 0 ? path.resolve(git.stdout.trim(), "..", "..", "..", "bin", "bash.exe") : undefined
    if (bash && (yield* fs.exists(bash).pipe(Effect.orElseSucceed(() => false)))) return bash
    return yield* Effect.fail(
      new UpgradeError({
        title: "Git Bash is required to update OpenCode",
        detail: "The OpenCode installer runs with Git Bash on Windows, and it was not found.",
        retry: "Install Git for Windows or set OPENCODE_GIT_BASH_PATH, then run opencode upgrade again.",
      }),
    )
  })

  const method = Effect.fnUntraced(function* () {
    if (fork) return "curl" as Method
    if (path.resolve(process.execPath) === curlBinary) return "curl"
    if (installedFormula) return "brew"
    if (!installedPackage) return

    const checks: ReadonlyArray<{ method: Method; command: string[] }> = [
      { method: "npm", command: ["npm", "list", "-g", "--depth=0", installedPackage] },
      { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", installedPackage] },
      { method: "bun", command: ["bun", "pm", "ls", "-g"] },
      { method: "yarn", command: ["yarn", "global", "list"] },
      { method: "vp", command: ["vp", "list", "-g", "--json", installedPackage] },
    ]
    const results = yield* Effect.forEach(
      checks,
      (check) =>
        exec(check.command).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
          Effect.map((result) => ({ check, result })),
        ),
      { concurrency: "unbounded" },
    )
    return results.find((result) => {
      if (result.check.method !== "vp") return result.result.stdout.includes(installedPackage)
      // Vite+ repeats the filter in its successful no-match message, so substring detection would be a false positive.
      return Option.exists(decodeVpPackages(result.result.stdout), (packages) =>
        packages.some((item) => item.name === installedPackage),
      )
    })?.check.method
  })

  const removal = (method: Method) => {
    if (method === "curl" || method === "brew" || !installedPackage) return undefined
    const commands = {
      npm: ["npm", "uninstall", "--global", installedPackage],
      pnpm: ["pnpm", "remove", "--global", installedPackage],
      bun: ["bun", "remove", "--global", installedPackage],
      yarn: ["yarn", "global", "remove", installedPackage],
      vp: ["vp", "uninstall", "-g", installedPackage],
    }
    const command = commands[method]
    return {
      command,
      run: retaining(
        method,
        exec(command, "5 minutes").pipe(
          Effect.flatMap((result) => (result.code === 0 ? Effect.void : Effect.fail(new Error(resultDetail(result))))),
        ),
        global.tmp,
      ),
    }
  }

  const release = Effect.fnUntraced(function* (method?: Method) {
    const distribution = method === "brew" ? "homebrew" : "npm"
    // Homebrew Core builds its formula on its own schedule, so the tap release does not describe it.
    const core = method === "brew" && installedFormula === "opencode"
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(
          core
            ? "https://formulae.brew.sh/api/formula/opencode.json"
            : `https://opencode.ai/update/api/${encodeURIComponent(channel)}/${encodeURIComponent(OPENCODE_ARTIFACT)}/${distribution}?current=${encodeURIComponent(OPENCODE_VERSION)}`,
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        ),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not check for OpenCode updates",
            detail: errorDetail(cause),
            retry: "Check your network, then run opencode upgrade again.",
          },
          { cause },
        ),
    })
    if (!response.ok)
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not check for OpenCode updates",
          detail: `The update service returned HTTP ${response.status}.`,
          retry: "Try again in a few minutes.",
        }),
      )
    const data: { version?: string; metadata?: { package?: string }; versions?: { stable?: string } } =
      yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new UpgradeError(
            {
              title: "Could not read the OpenCode update information",
              detail: errorDetail(cause),
              retry: "Try again in a few minutes.",
            },
            { cause },
          ),
      })
    const version = core ? data.versions?.stable : data.version
    const packageName = core ? "opencode" : data.metadata?.package
    if (!version || !packageName)
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not read the OpenCode update information",
          detail: "The update service returned incomplete release information.",
          retry: "Try again in a few minutes.",
        }),
      )
    return { package: packageName, version }
  })

  // Fork builds resolve updates from the fork repository's own prereleases. There is
  // deliberately no cache: the official path has none either, and a cached release list
  // would let a fresh upgrade resolve an already superseded prerelease.
  const forkReleases = Effect.fnUntraced(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`https://api.github.com/repos/${OPENCODE_UPDATE_REPOSITORY}/releases?per_page=30`, {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not check for fork updates",
            detail: errorDetail(cause),
            retry: "Check your network, then run opencode upgrade again.",
          },
          { cause },
        ),
    })
    if (!response.ok)
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not check for fork updates",
          detail: `GitHub returned HTTP ${response.status} for ${OPENCODE_UPDATE_REPOSITORY}.`,
          retry: "Try again in a few minutes.",
        }),
      )
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not read the fork release list",
            detail: errorDetail(cause),
            retry: "Try again in a few minutes.",
          },
          { cause },
        ),
    })
    const decoded = decodeForkReleases(text)
    if (Option.isNone(decoded))
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not read the fork release list",
          detail: `${OPENCODE_UPDATE_REPOSITORY} returned an unexpected release list.`,
          retry: "Try again in a few minutes.",
        }),
      )
    const list: ReadonlyArray<ForkRelease> = decoded.value
    return list
  })

  const forkText = Effect.fnUntraced(function* (url: string, title: string) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: { Accept: "application/octet-stream" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: (cause) =>
        new UpgradeError({ title, detail: errorDetail(cause), retry: "Check your network, then try again." }, { cause }),
    })
    if (!response.ok)
      return yield* Effect.fail(
        new UpgradeError({
          title,
          detail: `The download returned HTTP ${response.status}.`,
          retry: "Check the release on GitHub, then try again.",
        }),
      )
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new UpgradeError({ title, detail: errorDetail(cause), retry: "Check your network, then try again." }, { cause }),
    })
  })

  const forkChecksum = Effect.fnUntraced(function* (url: string) {
    const text = yield* forkText(url, "Could not read the fork release checksum")
    const hash = text.match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase()
    if (!hash)
      return yield* Effect.fail(
        new UpgradeError({
          title: "Fork release checksum was invalid",
          detail: `${url} does not start with a SHA256 sum.`,
          retry: "Report the invalid asset; the release must be re-published.",
        }),
      )
    return hash
  })

  const forkDownload = Effect.fnUntraced(function* (url: string, target: string) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: { Accept: "application/octet-stream" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
        }),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not download the fork release",
            detail: errorDetail(cause),
            retry: "Check your network, then run opencode upgrade again.",
          },
          { cause },
        ),
    })
    const body = response.body
    if (!response.ok || !body)
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not download the fork release",
          detail: `The download returned HTTP ${response.status} without a body.`,
          retry: "Check the release on GitHub, then run opencode upgrade again.",
        }),
      )
    yield* Stream.run(
      Stream.fromReadableStream<Uint8Array, UpgradeError>({
        evaluate: () => body,
        onError: (cause) =>
          new UpgradeError({
            title: "Could not download the fork release",
            detail: errorDetail(cause),
            retry: "Check your network, then run opencode upgrade again.",
          }),
      }),
      fs.sink(target, { flag: "wx", mode: 0o700 }),
    )
  })

  // The whole point of the fork channel: the binary is fetched from the fork's own
  // prerelease, verified against its published checksum and only then swapped in.
  const forkUpgrade = Effect.fnUntraced(function* (input: string) {
    const asset = forkAssetName()
    if (!asset)
      return yield* Effect.fail(
        new UpgradeError({
          title: "This platform has no fork release",
          detail: `${OPENCODE_UPDATE_REPOSITORY} publishes ${OPENCODE_UPDATE_CHANNEL} builds for Linux x64 only.`,
          retry: "Build OpenCode from source on this platform.",
        }),
      )
    const target = normalizeForkVersion(input)
    if (!isForkRelease(target))
      return yield* Effect.fail(
        new UpgradeError({
          title: "Refusing a non-fork target",
          detail: `${input} is not a ${OPENCODE_UPDATE_CHANNEL} release.`,
          retry: `Pass an x.y.z-${OPENCODE_UPDATE_CHANNEL}.n version.`,
        }),
      )
    // v1 parity: an already current or newer install makes the fork upgrade a no-op.
    if (semver.valid(OPENCODE_VERSION) && semver.gte(OPENCODE_VERSION, target)) return

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        const releases = yield* forkReleases()
        const release = releases.find((item) => normalizeForkVersion(item.tag_name) === target)
        if (!release || !selectForkRelease([release], asset))
          return yield* Effect.fail(
            new UpgradeError({
              title: "Fork release assets were not found",
              detail: `${OPENCODE_UPDATE_REPOSITORY} has no published prerelease ${target} carrying ${asset} and ${asset}.sha256.`,
              retry: "Check the release on GitHub, then run opencode upgrade again.",
            }),
          )
        const binary = release.assets.find((item) => item.name === asset)!
        const checksum = release.assets.find((item) => item.name === `${asset}.sha256`)!
        const expected = yield* forkChecksum(checksum.browser_download_url)
        const temporary = `${executable}.update-${process.pid}-${Date.now()}`
        yield* Effect.gen(function* () {
          yield* forkDownload(binary.browser_download_url, temporary)
          const hasher = new Bun.CryptoHasher("sha256")
          yield* Stream.runForEach(fs.stream(temporary), (chunk) =>
            Effect.sync(() => {
              hasher.update(chunk)
            }),
          )
          const actual = hasher.digest("hex")
          if (actual !== expected)
            return yield* Effect.fail(
              new UpgradeError({
                title: "Fork release checksum verification failed",
                detail: `Expected ${expected}, got ${actual}.`,
                retry: "Report the mismatch; the release must be re-published.",
              }),
            )
          yield* fs.chmod(temporary, 0o755)
          const smoke = yield* exec([temporary, "--version"])
          if (smoke.code !== 0 || reportedVersion(smoke.stdout) !== target)
            return yield* Effect.fail(
              new UpgradeError({
                title: "Fork release binary verification failed",
                detail: `The downloaded binary reported ${JSON.stringify(smoke.stdout.trim())} instead of ${target}.`,
                retry: "Report the mismatch; the release must be re-published.",
              }),
            )
          yield* fs.rename(temporary, executable)
        }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : new UpgradeError(
              {
                title: "Could not prepare the fork upgrade",
                detail: errorDetail(cause),
                retry: "Fix the issue above, then run opencode upgrade again.",
              },
              { cause },
            ),
      ),
      Effect.asVoid,
    )
  })

  const latest = (selected?: Method) => {
    if (!fork)
      return (selected ? Effect.succeed(selected) : method()).pipe(
        Effect.flatMap(release),
        Effect.map((data) => data.version),
      )
    const asset = forkAssetName()
    return forkReleases().pipe(
      Effect.flatMap((releases) => {
        const release = selectForkRelease(releases, asset)
        if (!release)
          return Effect.fail(
            new UpgradeError({
              title: "No fork release found",
              detail: `${OPENCODE_UPDATE_REPOSITORY} has no published ${OPENCODE_UPDATE_CHANNEL} prerelease with a usable asset.`,
              retry: "Publish a fork prerelease, then run opencode upgrade again.",
            }),
          )
        return Effect.succeed(normalizeForkVersion(release.tag_name))
      }),
    )
  }

  const temporaryDirectory = (prefix: string) =>
    Effect.acquireRelease(fs.makeTempDirectory({ directory: global.cache, prefix }), (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    )

  // On Windows the installer must delete or replace the running binary, which only works
  // while another link to it exists (see RetainedImage). Upgrades keep that link in the
  // cache; uninstall has already removed the cache, so it uses the temporary directory.
  const retaining = <A, E, R>(method: Method, effect: Effect.Effect<A, E, R>, directory = global.cache) => {
    if (process.platform !== "win32" || method === "brew") return effect
    // Only the installed binary is at stake; source checkouts run inside bun or node.
    const owned = method === "curl" ? path.resolve(process.execPath) === curlBinary : installedPackage !== undefined
    if (!owned) return effect
    return Effect.scoped(RetainedImage.retain(directory, "upgrade").pipe(Effect.andThen(effect))).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
  }

  const runUpgrade = (input: {
    readonly method: Method
    readonly command: string[]
    readonly displayCommand?: string[]
    readonly title?: string
    readonly retry?: string
  }) => {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: input.title ?? `${installNames[input.method]} could not install OpenCode`,
          detail,
          command: (input.displayCommand ?? input.command).join(" "),
          retry: input.retry ?? "Fix the issue above, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    return exec(input.command, "5 minutes").pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.succeed(result) : Effect.fail(failure(resultDetail(result))),
      ),
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : failure(
              cause instanceof AppProcess.AppProcessError && cause.stderr === undefined && cause.cause === undefined
                ? `Failed to update with ${input.method}`
                : errorDetail(cause),
              cause,
            ),
      ),
    )
  }

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    const version = input.trim().replace(/^v/, "")
    if (!canUpgradeToTarget(OPENCODE_VERSION, version))
      return yield* Effect.fail(
        new UpgradeError({
          title: "Refusing to replace a fork build",
          detail: `${OPENCODE_VERSION} only upgrades to ${OPENCODE_UPDATE_CHANNEL} prereleases from ${OPENCODE_UPDATE_REPOSITORY}, so ${version} cannot replace this binary.`,
          retry: `Run opencode upgrade without a target to use the ${OPENCODE_UPDATE_CHANNEL} channel.`,
        }),
      )
    if (fork) return yield* forkUpgrade(version)
    const packageName =
      method === "brew" && installedFormula === "opencode" ? "opencode" : (yield* release(method)).package
    const target = `${packageName}@${version}`
    if (installedPackage && packageName !== installedPackage && (method === "pnpm" || method === "yarn")) {
      return yield* Effect.fail(new Error(`Reinstall ${target} with ${method} to migrate from ${installedPackage}.`))
    }
    const commands: Record<Exclude<Method, "bun" | "curl" | "brew">, string[]> = {
      // Keep the old package: uninstalling it can unlink the replacement command.
      npm: [
        "npm",
        "install",
        "--global",
        ...((OPENCODE_ARTIFACT === "cli" && !installedPackage?.endsWith("/cli-node")) ||
        (installedPackage && packageName !== installedPackage)
          ? ["--force"]
          : []),
        target,
      ],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      yarn: ["yarn", "global", "add", target],
      vp:
        installedPackage && packageName !== installedPackage
          ? ["vp", "install", "-g", "--force", target]
          : ["vp", "update", "-g", target],
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Other OpenCode processes may be installing at the same time. Wait longer than the
        // slowest install (curl runs two 5-minute commands).
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        if (method === "bun") {
          // Bun does not prune old versions from its shared package cache.
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const cache = yield* temporaryDirectory("update-")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: ["bun", "install", "--global", "--trust", "--cache-dir", cache, target],
              displayCommand: ["bun", "install", "--global", "--trust", target],
            }),
          )
        }
        if (method === "curl") {
          const bash = yield* installerBash()
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const directory = yield* temporaryDirectory("update-")
          const installer = path.join(directory, "install")
          yield* runUpgrade({
            method,
            command: ["curl", "-fsSL", "-o", installer, "https://opencode.ai/v2/install"],
            displayCommand: ["curl", "-fsSL", "https://opencode.ai/v2/install"],
            title: "Could not download the OpenCode installer",
            retry: "Check your network, then run opencode upgrade again.",
          })
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: [bash, installer, "--version", version, "--no-modify-path"],
              displayCommand: ["opencode", "upgrade", version, "--method", "curl"],
              title: "The OpenCode installer failed",
            }),
          )
        }
        if (method === "brew") return yield* runUpgrade({ method, command: ["brew", "upgrade", packageName] })
        return yield* retaining(method, runUpgrade({ method, command: commands[method] }))
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : new UpgradeError(
              {
                title: "Could not prepare the OpenCode upgrade",
                detail: errorDetail(cause),
                retry: "Fix the issue above, then run opencode upgrade again.",
              },
              { cause },
            ),
      ),
      Effect.asVoid,
    )
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return undefined
    }

    const current = yield* Ref.get(installedVersion)
    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current,
      latest: version,
    })
    const next = action(current, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return undefined
    }
    yield* Effect.logInfo("OpenCode update available", { current, latest: version, action: next })
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) {
      yield* Effect.logWarning("update skipped: installation method not found")
      return false
    }
    const current = yield* Ref.get(installedVersion)
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    yield* Effect.logInfo("updated OpenCode", { from: current, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version))) return yield* Effect.fail(new Error("Installation method not found"))
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: "This build runs from a source checkout. Use an installed OpenCode release to check for updates.",
      }
    const version = yield* latest()
    if (!parseReleaseVersion(version)) return yield* Effect.fail(new Error(`Invalid version: ${version}`))
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      onInstall(result.version)
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
