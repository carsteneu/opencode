#!/usr/bin/env bun

import { chmod, mkdir } from "node:fs/promises"
import path from "path"
import { Schema } from "effect"
import semver from "semver"

const repository = "carsteneu/opencode"
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

const version = process.argv.find((arg) => /^\d+\.\d+\.\d+-patched\.\d+$/.test(arg))
const publish = process.argv.includes("--publish")
if (!version) throw new Error("Usage: bun run release:patched <x.y.z-patched.n> [--publish]")

const root = path.resolve(import.meta.dir, "../../..")
const packageDir = path.join(root, "packages/opencode")
const head = (await run(["git", "rev-parse", "HEAD"], root)).trim()
const branch = (await run(["git", "branch", "--show-current"], root)).trim()
const status = (await run(["git", "status", "--short"], root)).trim()
const packageVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
  await Bun.file(path.join(packageDir, "package.json")).text(),
).version
const baseVersion = version.slice(0, version.indexOf("-patched."))
if (baseVersion !== packageVersion) {
  throw new Error(`Release base ${baseVersion} does not match packages/opencode version ${packageVersion}`)
}
if (publish && branch !== "working") throw new Error(`Patched releases must be published from working, got ${branch}`)
if (publish && status) throw new Error(`Worktree must be clean before publishing:\n${status}`)

if (!process.env.OPENTUI_ROOT) throw new Error("Set OPENTUI_ROOT to the pinned OpenTUI source worktree")
await run(["bun", "run", path.join(root, "script/sync-opentui-overlay.ts"), "--check"], root)

await run(["bun", "run", "build:patched", "--single", "--skip-install"], packageDir, {
  ...process.env,
  OPENCODE_VERSION: version,
})

const output = path.join(packageDir, "dist/patched-release")
const binary = path.join(output, "opencode-linux-x64")
const checksum = `${binary}.sha256`
await mkdir(output, { recursive: true })
await Bun.write(binary, Bun.file(path.join(packageDir, "dist/opencode-linux-x64/bin/opencode")))
await chmod(binary, 0o755)

const hash = new Bun.CryptoHasher("sha256")
const reader = Bun.file(binary).stream().getReader()
while (true) {
  const chunk = await reader.read()
  if (chunk.done) break
  hash.update(chunk.value)
}
await Bun.write(checksum, `${hash.digest("hex")}  opencode-linux-x64\n`)

const built = (await run([binary, "--version"], packageDir)).trim()
if (built !== version) throw new Error(`Built ${built}, expected ${version}`)
if (publish) {
  const builtStatus = (await run(["git", "status", "--short"], root)).trim()
  if (builtStatus) throw new Error(`Build changed the worktree; refusing to publish:\n${builtStatus}`)
}

console.log(`Prepared ${binary}`)
console.log(`Prepared ${checksum}`)
if (!publish) {
  console.log(`Re-run with --publish after committing this exact source to working`)
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
  .filter((tag) => /^\d+\.\d+\.\d+-patched\.\d+$/.test(tag))
  .sort(semver.rcompare)[0]
if (latest && !semver.gt(version, latest)) {
  throw new Error(`Release ${version} must be newer than current patched prerelease ${latest}`)
}

await run(["git", "push", "fork", "working"], root)
const remote = (await run(["git", "rev-parse", "fork/working"], root)).trim()
if (remote !== head) throw new Error(`fork/working is ${remote}, expected ${head}`)

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
      "Employee prerelease with fork-pinned, checksum-verified self-updates.",
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
const assets = new Map(staged.assets.map((asset) => [asset.name, asset.size]))
if (
  !staged.isDraft ||
  !staged.isPrerelease ||
  staged.tagName !== version ||
  staged.targetCommitish !== head ||
  assets.get("opencode-linux-x64") !== binarySize ||
  assets.get("opencode-linux-x64.sha256") !== checksumSize
) {
  throw new Error(`Draft release verification failed: ${JSON.stringify(staged)}`)
}
const remoteChecksum = await run(
  [
    "gh",
    "release",
    "download",
    version,
    "--repo",
    repository,
    "--pattern",
    "opencode-linux-x64.sha256",
    "--output",
    "-",
  ],
  root,
)
if (remoteChecksum !== (await Bun.file(checksum).text()))
  throw new Error("Uploaded checksum asset does not match locally")

await run(["gh", "release", "edit", version, "--repo", repository, "--draft=false", "--prerelease"], root)
const release = await getRelease(version)
if (!release || release.isDraft || !release.isPrerelease) {
  throw new Error(`Published release verification failed: ${JSON.stringify(release)}`)
}
console.log(release.url)

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
