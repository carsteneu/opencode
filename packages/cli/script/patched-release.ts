#!/usr/bin/env bun

import { chmod, mkdir, rm } from "node:fs/promises"
import path from "path"
import { Schema } from "effect"
import semver from "semver"
import { FORK_RELEASE_PATTERN, forkAssetName, normalizeForkVersion, reportedVersion } from "../src/services/updater-action"

const repository = "carsteneu/opencode"
const releaseBranch = "v2-release-path"
const Release = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number })),
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  tagName: Schema.String,
  targetCommitish: Schema.String,
  url: Schema.String,
})
const ReleaseList = Schema.Array(
  Schema.Struct({
    isDraft: Schema.Boolean,
    isPrerelease: Schema.Boolean,
    tagName: Schema.String,
  }),
)

const argument = process.argv.find((arg) => FORK_RELEASE_PATTERN.test(arg))
if (!argument) throw new Error("Usage: bun run release:patched <x.y.z-v2patched.n> [--publish] [--draft]")
const version = normalizeForkVersion(argument)
// `--draft` runs the publish path but stops after the draft has been verified, so the
// uploaded assets can be inspected before they become visible to the update channel.
const draft = process.argv.includes("--draft")
const publish = process.argv.includes("--publish") || draft
const asset = forkAssetName()
if (!asset) throw new Error("Fork releases are built for Linux x64 only")

const root = path.resolve(import.meta.dir, "../../..")
const packageDir = path.join(root, "packages/cli")
const head = (await run(["git", "rev-parse", "HEAD"], root)).trim()
const branch = (await run(["git", "branch", "--show-current"], root)).trim()
const status = (await run(["git", "status", "--short"], root)).trim()
const packageVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
  await Bun.file(path.join(packageDir, "package.json")).text(),
).version
const baseVersion = version.slice(0, version.indexOf("-v2patched."))
if (baseVersion !== packageVersion) {
  throw new Error(`Release base ${baseVersion} does not match packages/cli version ${packageVersion}`)
}
if (publish && branch !== releaseBranch) {
  throw new Error(`Fork releases must be published from ${releaseBranch}, got ${branch}`)
}
if (publish && status) throw new Error(`Worktree must be clean before publishing:\n${status}`)

// buildAppArchive runs the web UI's own `bun run build`, which resolves `node` from PATH.
// The bundled rolldown imports node:util.styleText (Node 20.12+), so fail loudly here
// instead of dying inside vite.
const node = Bun.which("node")
if (!node) throw new Error("The web UI step needs node on PATH")
const nodeVersion = (await run([node, "--version"], root)).trim().replace(/^v/, "")
const [nodeMajor = 0, nodeMinor = 0] = nodeVersion.split(".").map(Number)
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 12)) {
  throw new Error(`The web UI step needs Node >= 20.12 on PATH, found ${nodeVersion}`)
}

await run(["bun", "run", "check:opentui-pin"], root)

await run(["bun", "run", "build:patched", "--single", "--skip-install"], packageDir, {
  ...process.env,
  OPENCODE_VERSION: version,
})

const output = path.join(packageDir, "dist/v2patched-release")
const binary = path.join(output, asset)
const checksum = `${binary}.sha256`
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await Bun.write(binary, Bun.file(path.join(packageDir, "dist/cli-linux-x64/bin/opencode")))
await chmod(binary, 0o755)

const hash = new Bun.CryptoHasher("sha256")
const reader = Bun.file(binary).stream().getReader()
while (true) {
  const chunk = await reader.read()
  if (chunk.done) break
  hash.update(chunk.value)
}
await Bun.write(checksum, `${hash.digest("hex")}  ${asset}\n`)

const built = reportedVersion((await run([binary, "--version"], packageDir)).trim())
if (built !== version) throw new Error(`Built ${built}, expected ${version}`)

await smoke(binary, path.join(packageDir, "dist/v2patched-smoke"))

if (publish) {
  const builtStatus = (await run(["git", "status", "--short"], root)).trim()
  if (builtStatus) throw new Error(`Build changed the worktree; refusing to publish:\n${builtStatus}`)
}

console.log(`Prepared ${binary}`)
console.log(`Prepared ${checksum}`)
if (!publish) {
  console.log(`Re-run with --publish after committing this exact source to ${releaseBranch}`)
  process.exit(0)
}

const releases = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseList))(
  await run(
    ["gh", "release", "list", "--repo", repository, "--limit", "100", "--json", "tagName,isDraft,isPrerelease"],
    root,
  ),
)
const latest = releases
  .filter((release) => !release.isDraft && release.isPrerelease)
  .map((release) => release.tagName.replace(/^v/, ""))
  .filter((tag) => FORK_RELEASE_PATTERN.test(tag))
  .sort(semver.rcompare)[0]
if (latest && !semver.gt(version, latest)) {
  throw new Error(`Release ${version} must be newer than the current fork prerelease ${latest}`)
}

await run(["git", "push", "fork", releaseBranch], root)
const remote = (await run(["git", "rev-parse", `fork/${releaseBranch}`], root)).trim()
if (remote !== head) throw new Error(`fork/${releaseBranch} is ${remote}, expected ${head}`)

const existing = await getRelease(version)
if (existing && !existing.isDraft) throw new Error(`Published release ${version} already exists`)
if (existing && (existing.targetCommitish !== head || !existing.isPrerelease)) {
  throw new Error(`Existing draft does not match this release: ${JSON.stringify(existing)}`)
}
if (!existing) {
  const remoteTag = (await run(["git", "ls-remote", "--tags", "fork", `refs/tags/${version}`], root)).trim()
  if (remoteTag) throw new Error(`Remote tag ${version} already exists without a resumable draft release`)
  await run(
    [
      "gh",
      "release",
      "create",
      version,
      "--repo",
      repository,
      "--target",
      head,
      "--title",
      `OpenCode ${version}`,
      "--notes",
      `Fork prerelease with a checksum-verified self-update channel from ${repository}.`,
      "--prerelease",
      "--draft",
    ],
    root,
  )
}

await run(["gh", "release", "upload", version, binary, checksum, "--repo", repository, "--clobber"], root)

const staged = await getRelease(version)
if (!staged) throw new Error(`Draft release ${version} disappeared after upload`)
const binarySize = Bun.file(binary).size
const checksumSize = Bun.file(checksum).size
const assets = new Map(staged.assets.map((item) => [item.name, item.size]))
if (
  !staged.isDraft ||
  !staged.isPrerelease ||
  staged.tagName !== version ||
  staged.targetCommitish !== head ||
  assets.get(asset) !== binarySize ||
  assets.get(`${asset}.sha256`) !== checksumSize
) {
  throw new Error(`Draft release verification failed: ${JSON.stringify(staged)}`)
}
const remoteChecksum = await run(
  ["gh", "release", "download", version, "--repo", repository, "--pattern", `${asset}.sha256`, "--output", "-"],
  root,
)
if (remoteChecksum !== (await Bun.file(checksum).text())) {
  throw new Error("Uploaded checksum asset does not match locally")
}
if (draft) {
  console.log(`Verified draft ${staged.url}`)
  console.log(
    `Draft holds ${asset} (${binarySize} bytes) and ${asset}.sha256 (${checksumSize} bytes), checksum round-trip identical`,
  )
  process.exit(0)
}

await run(["gh", "release", "edit", version, "--repo", repository, "--draft=false", "--prerelease"], root)
const release = await getRelease(version)
if (!release || release.isDraft || !release.isPrerelease) {
  throw new Error(`Published release verification failed: ${JSON.stringify(release)}`)
}
console.log(release.url)

/**
 * Boots the built binary in a pty with its own XDG directories and asserts it renders,
 * reconciles plugins and logs no errors. v1 ran the same check through Ghostty; a bare
 * `script` pty keeps it independent of a terminal emulator being installed.
 */
async function smoke(binary: string, directory: string) {
  await rm(directory, { recursive: true, force: true })
  const data = path.join(directory, "data")
  for (const name of ["data", "config", "cache", "state"]) await mkdir(path.join(directory, name), { recursive: true })
  const transcript = path.join(directory, "transcript.io")
  const launcher = path.join(directory, "launch.sh")
  await Bun.write(
    launcher,
    [
      "#!/bin/sh",
      `export XDG_DATA_HOME=${JSON.stringify(data)}`,
      `export XDG_CONFIG_HOME=${JSON.stringify(path.join(directory, "config"))}`,
      `export XDG_CACHE_HOME=${JSON.stringify(path.join(directory, "cache"))}`,
      `export XDG_STATE_HOME=${JSON.stringify(path.join(directory, "state"))}`,
      "export TERM=xterm-256color",
      "export OPENCODE_SHOW_TTFD=1",
      `exec timeout 25 ${JSON.stringify(binary)} --standalone`,
      "",
    ].join("\n"),
  )
  await chmod(launcher, 0o755)
  const render = await spawn(["timeout", "45", "script", "-qfec", launcher, transcript], packageDir, {
    ...process.env,
    TERM: "xterm-256color",
  })
  const rendered = (await Bun.file(transcript).exists()) ? await Bun.file(transcript).text() : ""
  const applicationLog = Bun.file(path.join(data, "opencode/log/opencode.log"))
  const log = (await applicationLog.exists()) ? await applicationLog.text() : ""
  const diagnostic = [rendered, render.stdout, render.stderr].join("\n")
  if (/opencode crashed|An unexpected error stopped the session|tui bootstrap failed|AbortError/i.test(diagnostic)) {
    throw new Error(`TUI smoke test hit a crash; artifacts retained in ${directory}`)
  }
  if (!rendered.includes(version)) {
    throw new Error(`TUI smoke test never rendered ${version}; artifacts retained in ${directory}`)
  }
  if (/level=ERROR/.test(log)) {
    throw new Error(`TUI smoke test logged an error; artifacts retained in ${directory}`)
  }
  const plugins = log.match(/plugin reconciliation completed[^\n]*plugins=([0-9]+)/)?.[1]
  if (!plugins || Number(plugins) < 1) {
    throw new Error(`TUI smoke test did not reconcile any plugin; artifacts retained in ${directory}`)
  }
  await rm(directory, { recursive: true, force: true })
  console.log(`TUI smoke test passed (${plugins} plugins reconciled, no errors)`)
}

async function getRelease(tag: string) {
  const result = await spawn(
    [
      "gh",
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "assets,isDraft,isPrerelease,tagName,targetCommitish,url",
    ],
    root,
  )
  if (result.code === 0) return Schema.decodeUnknownSync(Schema.fromJsonString(Release))(result.stdout)
  if (/release not found|HTTP 404/i.test(result.stderr)) return undefined
  throw new Error(result.stderr.trim() || `Could not inspect release ${tag}`)
}

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = await spawn(command, cwd, env)
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${command.join(" ")} failed`)
  return result.stdout
}

async function spawn(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
