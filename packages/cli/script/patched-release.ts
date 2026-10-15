#!/usr/bin/env bun

import { chmod, mkdir, rm } from "node:fs/promises"
import path from "path"
import { Schema } from "effect"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import { reportedVersion } from "../src/services/updater-action"
import { planForkRelease, type KnownRelease } from "./patched-release-plan"

// The branch that may publish. Overridable because this feature branch is not meant to
// outlive the merge into the v2 release branch.
const releaseBranch = process.env.OPENCODE_RELEASE_BRANCH?.trim() || "v2-release-align"
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
const Draft = Schema.Struct({
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  targetCommitish: Schema.String,
})

const argument = process.argv.find((arg) => ForkRelease.version(arg) !== undefined)
if (!argument)
  throw new Error(
    `Usage: bun run release:patched <x.y.z-${ForkRelease.channel}.n> [--publish] [--draft] ` +
      `(OPENCODE_RELEASE_BRANCH overrides ${releaseBranch})`,
  )
const version = ForkRelease.version(argument)!
// Also the platform guard: without an asset for this platform there is nothing to release.
const asset = ForkRelease.asset()
if (!asset) throw new Error("Patched releases are built for Linux x64 only")
const checksumAsset = ForkRelease.checksumAsset(asset)
// `--draft` runs the publish path but stops after the draft has been verified, so the
// uploaded assets can be inspected before they become visible to the update channel.
const draft = process.argv.includes("--draft")
const publish = process.argv.includes("--publish") || draft

const root = path.resolve(import.meta.dir, "../../..")
const packageDir = path.join(root, "packages/cli")
const head = (await run(["git", "rev-parse", "HEAD"], root)).trim()
const branch = (await run(["git", "branch", "--show-current"], root)).trim()
// A tag push is the publishing route: GitHub resolves it to refs/tags/<name>, checks that
// commit out (a detached HEAD, so `branch` is empty) and reads this script from the tagged
// commit. The tag then names the release and stands in for the branch as its identity; a
// local run carries no such ref and keeps publishing from the release branch.
const pushedTag = process.env.GITHUB_REF?.match(/^refs\/tags\/(.+)$/)?.[1]
const tag = pushedTag ? ForkRelease.version(pushedTag) : undefined
const worktree = (await run(["git", "status", "--short"], root)).trim()
const packageVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
  await Bun.file(path.join(packageDir, "package.json")).text(),
).version

// These guards run before the build and before anything reaches the remote, so a refusal
// here costs no build and touches no shared state.
let plan = planForkRelease({
  version,
  publish,
  releaseBranch,
  branch,
  tag,
  worktree,
  packageVersion,
  releases: publish ? await knownReleases() : [],
  existing: publish ? await knownDraft() : undefined,
  head,
})
if (plan.action === "refuse") throw new Error(plan.reason)

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

const output = path.join(packageDir, "dist/patched-release")
const binary = path.join(output, asset)
const checksum = path.join(output, checksumAsset)
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
await Bun.write(checksum, ForkRelease.checksumFile(hash.digest("hex"), asset))

const built = (await run([binary, "--version"], packageDir)).trim()
if (reportedVersion(built) !== version) throw new Error(`Built ${reportedVersion(built)}, expected ${version}`)
// `reportedVersion` takes the last token, so it cannot see a banner. The frozen 1.x installer
// compares the probe output verbatim, so a prefix would abort a transfer after the download and
// the checksum: refuse to publish a binary that reports anything but the bare version.
if (built !== version) throw new Error(`Built binary reports ${JSON.stringify(built)}, expected exactly ${version}`)

// The repository is a constant of the release contract, so this scan proves the contract is
// compiled into the artifact. The channel itself is proven above: a build that lost the
// patched version string would not be recognised as a fork build at all.
if (!(await containsMarker(binary, ForkRelease.repository)))
  throw new Error(`The built binary does not carry the ${ForkRelease.repository} marker; refusing to release`)

await smoke(binary, path.join(packageDir, "dist/patched-smoke"))

if (publish) {
  const builtStatus = (await run(["git", "status", "--short"], root)).trim()
  if (builtStatus) throw new Error(`Build changed the worktree; refusing to publish:\n${builtStatus}`)
  // The plan was computed before the build; a release published meanwhile must not be
  // written over by one that is no longer the newest, so re-confirm against fresh state.
  plan = planForkRelease({
    version,
    publish,
    releaseBranch,
    branch,
    tag,
    worktree: builtStatus,
    packageVersion,
    releases: await knownReleases(),
    existing: await knownDraft(),
    head,
  })
  if (plan.action === "refuse") throw new Error(plan.reason)
}

console.log(`Prepared ${binary}`)
console.log(`Prepared ${checksum}`)
if (!publish) {
  console.log(`Re-run with --publish after committing this exact source to ${releaseBranch}`)
  process.exit(0)
}

if (!tag) {
  await run(["git", "push", "fork", releaseBranch], root)
  const remote = (await run(["git", "rev-parse", `fork/${releaseBranch}`], root)).trim()
  if (remote !== head) throw new Error(`fork/${releaseBranch} is ${remote}, expected ${head}`)
} else {
  // The tag is what triggered this run, so it has to be on the fork and point at the commit
  // that was checked out - the same remote-to-head binding the branch push gives above, and
  // the only one available once the tag pre-exists. Checked on the resume path too: a re-run
  // of a tag that has been moved would otherwise publish an older build under it.
  const remoteTag = await forkTagCommit()
  if (remoteTag !== head) throw new Error(`fork tag ${version} is ${remoteTag ?? "missing"}, expected ${head}`)
}

if (plan.action === "create") {
  // gh creates the tag from this commit below on the branch route, so it must not be there yet.
  if (!tag && (await forkTagCommit()))
    throw new Error(`Remote tag ${version} already exists without a resumable draft release`)
  await run(
    [
      "gh",
      "release",
      "create",
      version,
      "--repo",
      ForkRelease.repository,
      "--target",
      head,
      "--title",
      `OpenCode ${version}`,
      "--notes",
      `Fork prerelease with a checksum-verified self-update channel from ${ForkRelease.repository}.`,
      "--prerelease",
      "--draft",
    ],
    root,
  )
}

await run(["gh", "release", "upload", version, binary, checksum, "--repo", ForkRelease.repository, "--clobber"], root)

const staged = await getRelease(version)
if (!staged) throw new Error(`Draft release ${version} disappeared after upload`)
const binarySize = Bun.file(binary).size
const checksumSize = Bun.file(checksum).size
const assets = new Map(staged.assets.map((item) => [item.name, item.size]))
// GitHub documents target_commitish as unused when the tag already exists, so on the tag
// route it can name something other than this commit even though the release is bound to
// it through the tag (proven against the fork above). Its value is reported instead of
// compared there; on the branch route it still has to be this commit.
const commitishIsHead = tag ? true : staged.targetCommitish === head
if (tag)
  console.log(
    `Tag-driven draft reports target_commitish ${JSON.stringify(staged.targetCommitish)} (not compared; the tag binds the release to ${head})`,
  )
if (
  !staged.isDraft ||
  !staged.isPrerelease ||
  staged.tagName !== version ||
  !commitishIsHead ||
  assets.get(asset) !== binarySize ||
  assets.get(checksumAsset) !== checksumSize
) {
  throw new Error(`Draft release verification failed: ${JSON.stringify(staged)}`)
}
const remoteChecksum = await run(
  ["gh", "release", "download", version, "--repo", ForkRelease.repository, "--pattern", checksumAsset, "--output", "-"],
  root,
)
if (remoteChecksum !== (await Bun.file(checksum).text())) {
  throw new Error("Uploaded checksum asset does not match locally")
}
console.log(
  `Verified draft: ${asset} (${binarySize} bytes) and ${checksumAsset} (${checksumSize} bytes), checksum round-trip identical`,
)
if (draft) {
  console.log(
    `Draft ${version} staged and verified; publish it with: gh release edit ${version} --repo ${ForkRelease.repository} --draft=false --prerelease`,
  )
  process.exit(0)
}

await run(["gh", "release", "edit", version, "--repo", ForkRelease.repository, "--draft=false", "--prerelease"], root)
const release = await getRelease(version)
if (!release || release.isDraft || !release.isPrerelease) {
  throw new Error(`Published release verification failed: ${JSON.stringify(release)}`)
}
console.log(release.url)

async function knownReleases(): Promise<ReadonlyArray<KnownRelease>> {
  return Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseList))(
    await run(
      ["gh", "release", "list", "--repo", ForkRelease.repository, "--limit", "100", "--json", "tagName,isDraft,isPrerelease"],
      root,
    ),
  )
}

async function knownDraft() {
  const result = await spawn(
    ["gh", "release", "view", version, "--repo", ForkRelease.repository, "--json", "isDraft,isPrerelease,targetCommitish"],
    root,
  )
  if (result.code === 0) return Schema.decodeUnknownSync(Schema.fromJsonString(Draft))(result.stdout)
  if (/release not found|HTTP 404/i.test(result.stderr)) return undefined
  throw new Error(result.stderr.trim() || `Could not inspect release ${version}`)
}

/** Commit the fork's tag for this release points at, or undefined when the tag is absent. */
async function forkTagCommit() {
  const ref = `refs/tags/${version}`
  const lines = (await run(["git", "ls-remote", "--tags", "fork", ref], root)).split("\n")
  // ls-remote lists an annotated tag twice, the second time as `<ref>^{}` for the commit it
  // peels to; the release tags are created lightweight, so the plain ref is the one to read.
  return lines.find((line) => line.trim().endsWith(ref))?.split(/\s+/)[0]
}

async function containsMarker(file: string, marker: string) {
  const reader = Bun.file(file).stream().getReader()
  let trailing = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return false
    const text = trailing + Buffer.from(chunk.value).toString("latin1")
    if (text.includes(marker)) return true
    trailing = text.slice(-(marker.length - 1))
  }
}

/**
 * Boots the built binary in a pty with its own XDG directories and asserts it renders,
 * reconciles plugins and logs no errors. v1 ran the same check through Ghostty; a bare
 * `script` pty keeps it independent of a terminal emulator being installed.
 */
async function smoke(binary: string, directory: string) {
  await rm(directory, { recursive: true, force: true })
  const launcher = path.join(directory, "launch.sh")
  const transcript = path.join(directory, "transcript.io")
  await mkdir(directory, { recursive: true })
  for (const name of ["data", "config", "cache", "state"]) await mkdir(path.join(directory, name), { recursive: true })
  // Every path reaches the launcher through the environment: no path is ever interpolated
  // into shell source, so a checkout below a directory with shell metacharacters cannot
  // inject a command into the smoke test.
  await Bun.write(
    launcher,
    ["#!/bin/sh", "set -u", 'exec timeout 25 "$OPENCODE_SMOKE_BINARY" --standalone', ""].join("\n"),
  )
  await chmod(launcher, 0o755)
  const data = path.join(directory, "data")
  const render = await spawn(["timeout", "45", "script", "-qfec", "./launch.sh", transcript], directory, {
    ...process.env,
    TERM: "xterm-256color",
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    OPENCODE_SMOKE_BINARY: binary,
    OPENCODE_SHOW_TTFD: "1",
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
      ForkRelease.repository,
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
