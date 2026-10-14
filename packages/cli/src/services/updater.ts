import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import {
  OPENCODE_ARTIFACT,
  OPENCODE_CHANNEL,
  OPENCODE_LOCAL,
  OPENCODE_UPDATE_CHANNEL,
  OPENCODE_VERSION,
} from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { createHash, randomUUID } from "node:crypto"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { RetainedImage } from "./retained-image"
import { action, compareRelease, majorChange, parseReleaseVersion, updates, type Policy } from "./updater-action"
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

// Redirect hops keep the same policy as published asset URLs: https only, no
// credentials. GitHub's asset URLs redirect to a signed object host.
function hop(input: string, base: string) {
  try {
    const parsed = new URL(input, base)
    if (parsed.protocol !== "https:") return
    if (parsed.username || parsed.password) return
    return parsed.toString()
  } catch {
    return
  }
}

const checksumLimit = 4 * 1024
const binaryLimit = 256 * 1024 * 1024

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

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
  // A patched build is installed as a raw release asset, so it never reads the
  // upstream release service and never installs through a package manager. The
  // version shape counts too: a hand-built patched binary must not fall back to
  // upstream just because its update channel was left at the default.
  const fork = OPENCODE_UPDATE_CHANNEL === ForkRelease.channel || ForkRelease.version(OPENCODE_VERSION) !== undefined
  const forkReleasesCache = yield* Ref.make<
    | {
        readonly at: number
        readonly list: ReadonlyArray<ForkRelease.Release>
      }
    | undefined
  >(undefined)
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
    // A patched install is always the raw binary from the install script.
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

  const versioned = (list: ReadonlyArray<ForkRelease.Release>) =>
    list.flatMap((release) => {
      const version = ForkRelease.version(release.tag_name)
      return version === undefined ? [] : [{ ...release, version }]
    })

  // GitHub's unauthenticated limit is 60 requests per hour per address, so an
  // upgrade reuses the listing it resolved moments earlier.
  const forkReleases = Effect.fnUntraced(function* () {
    const cached = yield* Ref.get(forkReleasesCache)
    const now = Date.now()
    if (cached && now - cached.at < 60_000) return versioned(cached.list)
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(ForkRelease.releasesUrl(), { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }),
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
          detail: `The patched release service returned HTTP ${response.status}.`,
          retry: "Try again in a few minutes.",
        }),
      )
    const data: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new UpgradeError(
          {
            title: "Could not read the patched release information",
            detail: errorDetail(cause),
            retry: "Try again in a few minutes.",
          },
          { cause },
        ),
    })
    if (!Array.isArray(data))
      return yield* Effect.fail(
        new UpgradeError({
          title: "Could not read the patched release information",
          detail: "The patched release service returned an unexpected payload.",
          retry: "Try again in a few minutes.",
        }),
      )
    const list = ForkRelease.candidates(ForkRelease.releases(data))
    yield* Ref.set(forkReleasesCache, { at: now, list })
    return versioned(list)
  })

  const forkLatest = Effect.fnUntraced(function* () {
    const newest = (yield* forkReleases()).sort((left, right) => compareRelease(right.version, left.version) ?? 0)[0]
    if (newest) return newest
    return yield* Effect.fail(
      new UpgradeError({
        title: "No patched release is available",
        detail: `${ForkRelease.repository} has no complete patched release for ${process.platform}/${process.arch}.`,
        retry: "Try again later.",
      }),
    )
  })

  const latest = (selected?: Method) =>
    fork
      ? forkLatest().pipe(Effect.map((release) => release.version))
      : (selected ? Effect.succeed(selected) : method()).pipe(
          Effect.flatMap(release),
          Effect.map((data) => data.version),
        )

  const download = Effect.fnUntraced(function* (url: string, label: string, limit: number) {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: `Could not download ${label}`,
          detail,
          retry: "Check your network, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    const request = (target: string) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(target, {
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(Duration.toMillis("5 minutes"))]),
          }),
        catch: (cause) => failure(errorDetail(cause), cause),
      })
    // GitHub signs asset downloads behind a redirect, so hops are followed by
    // hand: every one of them has to pass the same URL policy as the payload.
    let response: Response | undefined
    let current = url
    for (let count = 0; count <= 5; count++) {
      const answer = yield* request(current)
      if (answer.status < 300 || answer.status >= 400) {
        response = answer
        break
      }
      const location = answer.headers.get("location")
      const next = location === null ? undefined : hop(location, current)
      if (!next)
        return yield* Effect.fail(
          new UpgradeError({
            title: `Could not download ${label}`,
            detail: "The release service redirected to an address that is not allowed.",
            retry: "Try again later.",
          }),
        )
      current = next
    }
    if (!response)
      return yield* Effect.fail(
        new UpgradeError({
          title: `Could not download ${label}`,
          detail: "The release service redirected too often.",
          retry: "Try again later.",
        }),
      )
    if (!response.ok)
      return yield* Effect.fail(
        new UpgradeError({
          title: `Could not download ${label}`,
          detail: `The release service returned HTTP ${response.status}.`,
          retry: "Try again in a few minutes.",
        }),
      )
    if (Number(response.headers.get("content-length") ?? "0") > limit)
      return yield* Effect.fail(failure(`The download exceeds the ${limit} byte limit.`, undefined))
    return yield* Effect.tryPromise({
      // Reading in chunks keeps a lying or missing Content-Length from buffering
      // an unbounded body.
      try: async () => {
        const reader = response.body?.getReader()
        if (!reader) throw failure("The release service returned no body.")
        const chunks: Array<Uint8Array> = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > limit) {
            await reader.cancel()
            throw failure(`The download exceeds the ${limit} byte limit.`)
          }
          chunks.push(value)
        }
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        return bytes
      },
      catch: (cause) => (cause instanceof UpgradeError ? cause : failure(errorDetail(cause), cause)),
    })
  })

  // Downloads beside the target and renames over it only after the checksum and
  // a version probe pass, so a failed update leaves the installed binary alone.
  const upgradeFork = Effect.fnUntraced(
    function* (target: string) {
      const binary = ForkRelease.asset()
      if (!binary)
        return yield* Effect.fail(
          new UpgradeError({
            title: "Patched releases do not cover this platform",
            detail: `${ForkRelease.repository} publishes no patched release for ${process.platform}/${process.arch}.`,
            retry: "Install a standard OpenCode release for this platform.",
          }),
        )
      // Only the binary the install script placed is ours to replace; a source
      // checkout or a package manager install must survive untouched. Compare
      // resolved paths because $HOME itself may be a symlink.
      const installed = yield* fs.realPath(curlBinary).pipe(Effect.orElseSucceed(() => curlBinary))
      if (executable !== installed)
        return yield* Effect.fail(
          new UpgradeError({
            title: "This OpenCode is not a patched install",
            detail: `Patched releases replace ${installed}, but OpenCode runs from ${executable}.`,
            retry: "Install OpenCode with the install script, then run opencode upgrade again.",
          }),
        )
      const current = yield* Ref.get(installedVersion)
      const order = compareRelease(target, current)
      if (order === 0) return
      if (order === -1)
        return yield* Effect.fail(
          new UpgradeError({
            title: "Patched release is not newer",
            detail: `${target} is not newer than the installed ${current}.`,
            retry: "Run opencode upgrade to install the newest patched release.",
          }),
        )

      return yield* Effect.scoped(
        Effect.gen(function* () {
          // The same lock name the 1.x line uses: a 1.x background upgrade may
          // still be running against this binary during the transfer.
          yield* flock.acquire(`installation-upgrade:${executable}`, undefined, {
            timeoutMs: Duration.toMillis("15 minutes"),
          })
          const release = (yield* forkReleases()).find((item) => item.version === target)
          if (!release)
            return yield* Effect.fail(
              new UpgradeError({
                title: "Patched release not found",
                detail: `${target} has no complete asset pair in ${ForkRelease.repository}.`,
                retry: "Check the version, then run opencode upgrade again.",
              }),
            )
          const checksum = release.assets.find((item) => item.name === ForkRelease.checksumAsset(binary))
          const asset = release.assets.find((item) => item.name === binary)
          if (!checksum || !asset)
            return yield* Effect.fail(
              new UpgradeError({
                title: "Patched release is incomplete",
                detail: `${target} is missing ${binary} or ${ForkRelease.checksumAsset(binary)}.`,
                retry: "Try again later.",
              }),
            )

          const expected = ForkRelease.checksumDigest(
            new TextDecoder().decode(
              yield* download(checksum.browser_download_url, "the patched release checksum", checksumLimit),
            ),
          )
          if (!expected)
            return yield* Effect.fail(
              new UpgradeError({
                title: "Patched release checksum is invalid",
                detail: `${ForkRelease.checksumAsset(binary)} does not start with a SHA-256 digest.`,
                retry: "Try again later.",
              }),
            )

          // A fresh name per attempt and exclusive creation: a leftover from a
          // killed run cannot be followed through as a symlink.
          const temporary = `${executable}.update-${randomUUID()}`
          yield* Effect.gen(function* () {
            const bytes = yield* download(asset.browser_download_url, `OpenCode ${target}`, binaryLimit)
            if (createHash("sha256").update(bytes).digest("hex") !== expected)
              return yield* Effect.fail(
                new UpgradeError({
                  title: "Patched release checksum does not match",
                  detail: `The downloaded ${binary} does not match its published checksum.`,
                  retry: "Try again later; the installed OpenCode was left unchanged.",
                }),
              )
            yield* fs.writeFile(temporary, bytes, { flag: "wx" })
            yield* fs.chmod(temporary, 0o755)
            const probe = yield* exec([temporary, "--version"]).pipe(Effect.orElseSucceed(() => undefined))
            const reported = probe?.stdout.trim().split(/\s+/).at(-1)?.replace(/^v/, "")
            if (probe?.code !== 0 || reported !== target)
              return yield* Effect.fail(
                new UpgradeError({
                  title: "Patched release binary failed verification",
                  detail: `The downloaded binary reported ${reported ?? "no version"} instead of ${target}.`,
                  retry: "Try again later; the installed OpenCode was left unchanged.",
                }),
              )
            yield* fs.rename(temporary, executable)
          }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
        }),
      )
    },
    Effect.mapError((cause) =>
      cause instanceof UpgradeError
        ? cause
        : new UpgradeError(
            {
              title: "Could not install the patched release",
              detail: errorDetail(cause),
              retry: "Fix the issue above, then run opencode upgrade again.",
            },
            { cause },
          ),
    ),
  )

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
    if (fork) {
      if (!ForkRelease.version(version))
        return yield* Effect.fail(
          new UpgradeError({
            title: "Not a patched OpenCode release",
            detail: `${version} is not a release of ${ForkRelease.repository}. A patched build only installs patched releases.`,
            retry: "Run opencode upgrade to use the newest patched release.",
          }),
        )
      return yield* upgradeFork(version)
    }
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
      // A major change is named as such: it is never applied automatically and
      // needs the explicit transfer command.
      yield* Effect.logInfo("update check done", {
        action: majorChange(current, version) ? "major-requires-transfer" : "up-to-date",
      })
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
    if (!updates(current, version)) {
      // An earlier check may have installed the update while this client is still running.
      return updates(OPENCODE_VERSION, current) ? { type: "installed" as const, version: current } : undefined
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
export { action, majorChange, updates, type Action, type Policy } from "./updater-action"
