#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { cp, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"

const expectedCommit = "13dc719306083c90040470ff401b3f29bee3dffb"
const expectedPatchBase = "568db413e7bc3a110981d2e54ddb7ebb8e906075"
const expectedTag = "v0.5.3"
const expectedTagCommit = "1500698af07951ea0c1c67c9ad737fc54382ee20"
const expectedVersion = "0.5.3"
const expectedHashes = {
  core: "9df11fb30fbd61e4721db028a0534c04fa9066532f360450314f3fde6bbb3440",
  solid: "ba9ffd6b55ea9f2785a01cc3b072bd3587116442607f5f19d20b383d75d16179",
  native: "7d02a2b2af22567c5ed5f625e7791d4343f5d53cfb227aa93e59b0372dc24c97",
}
const usage = "Usage: bun run script/sync-opentui-overlay.ts --source=<opentui-root> [--check | --apply]"
const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage)
  process.exit(0)
}

const apply = args.includes("--apply")
const unknown = args.find((arg) => arg !== "--apply" && arg !== "--check" && !arg.startsWith("--source="))
const sources = args.filter((arg) => arg.startsWith("--source="))
if (unknown || sources.length > 1 || (apply && args.includes("--check"))) {
  if (unknown) console.error(`Unknown option: ${unknown}`)
  console.error(usage)
  process.exit(1)
}

const sourceArg = args.find((arg) => arg.startsWith("--source="))?.slice("--source=".length)
const source = path.resolve(sourceArg || process.env.OPENTUI_ROOT || "")
if (!sourceArg && !process.env.OPENTUI_ROOT) {
  console.error("Missing --source or OPENTUI_ROOT")
  console.error(usage)
  process.exit(1)
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This pinned overlay contains only the tested Linux x64 native artifact")
}

const root = path.resolve(import.meta.dir, "..")
const head = await git(source, "rev-parse", "HEAD")
const tag = await git(source, "rev-parse", `${expectedTag}^{commit}`)
const patchBase = await git(source, "merge-base", expectedPatchBase, head)
const upstreamBase = await git(source, "merge-base", expectedTagCommit, head)
const status = await git(source, "status", "--short", "--untracked-files=no")
if (
  head !== expectedCommit ||
  tag !== expectedTagCommit ||
  patchBase !== expectedPatchBase ||
  upstreamBase !== expectedTagCommit
) {
  throw new Error(
    `Expected patched OpenTUI ${expectedVersion} at ${expectedCommit}, got HEAD ${head}, tag ${tag}, patch base ${patchBase}, and upstream base ${upstreamBase}`,
  )
}
if (status) throw new Error(`OpenTUI has tracked changes:\n${status}`)

const coreTarget = await realpath(path.join(root, "packages/tui/node_modules/@opentui/core"))
const artifacts = [
  {
    name: "core",
    source: path.join(source, "packages/core/dist"),
    target: coreTarget,
    expected: expectedHashes.core,
  },
  {
    name: "solid",
    source: path.join(source, "packages/solid/dist"),
    target: await realpath(path.join(root, "packages/tui/node_modules/@opentui/solid")),
    expected: expectedHashes.solid,
  },
  {
    name: "native",
    source: path.join(source, "packages/core/node_modules/@opentui/core-linux-x64"),
    target: await realpath(path.join(coreTarget, "..", "core-linux-x64")),
    expected: expectedHashes.native,
  },
]

const store = `${await realpath(path.join(root, "node_modules/.bun"))}${path.sep}`
for (const artifact of artifacts) {
  if (!artifact.target.startsWith(store)) throw new Error(`${artifact.name} target escaped the local Bun store`)
  const version = await Bun.file(path.join(artifact.source, "package.json")).json()
  if (version.version !== expectedVersion) {
    throw new Error(`Expected ${artifact.name} version ${expectedVersion}, got ${version.version}`)
  }
  const targetVersion = await Bun.file(path.join(artifact.target, "package.json")).json()
  if (targetVersion.version !== expectedVersion) {
    throw new Error(
      `${artifact.name} dependency slot is ${targetVersion.version}; expected ${expectedVersion}. Update the pinned overlay first`,
    )
  }
  const hash = await digest(artifact.source)
  if (hash !== artifact.expected) {
    throw new Error(`${artifact.name} source hash mismatch: expected ${artifact.expected}, got ${hash}`)
  }
}

if (apply) {
  for (const artifact of artifacts) {
    await replaceDirectory(artifact.source, artifact.target)
  }
}

const results = await Promise.all(
  artifacts.map(async (artifact) => ({
    name: artifact.name,
    expected: artifact.expected,
    actual: await digest(artifact.target),
  })),
)

for (const result of results) {
  console.log(`${result.name}: ${result.actual}${result.actual === result.expected ? " (verified)" : " (mismatch)"}`)
}

if (results.some((result) => result.actual !== result.expected)) {
  if (!apply) console.error("Run again with --apply to install the pinned OpenTUI overlay")
  process.exit(1)
}

console.log(apply ? "Pinned OpenTUI overlay installed and verified" : "Pinned OpenTUI overlay verified")
console.log("Build OpenCode with --skip-install so the verified overlay is not replaced")

async function git(cwd: string, ...command: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...command], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `git ${command.join(" ")} failed`)
  return stdout.trim()
}

async function digest(directory: string) {
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }))).sort()
  const hash = new Bun.CryptoHasher("sha256")
  // Include relative names and separators so equal bytes at different paths cannot collide.
  for (const file of files) {
    hash.update(file)
    hash.update("\0")
    hash.update(await Bun.file(path.join(directory, file)).arrayBuffer())
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function replaceDirectory(source: string, target: string) {
  const staged = `${target}.overlay-${randomUUID()}`
  const backup = `${target}.backup-${randomUUID()}`
  // Replacing the directory breaks Bun cache hardlinks without mutating the global cache.
  try {
    await cp(source, staged, { recursive: true, preserveTimestamps: true })
    await rename(target, backup)
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    throw error
  }
  try {
    await rename(staged, target)
  } catch (error) {
    await rename(backup, target)
    await rm(staged, { recursive: true, force: true })
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}
