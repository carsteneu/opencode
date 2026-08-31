#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { cp, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"

const expectedCommit = "225e532fe0caf0fe6db3b94cb5fe1510e3341e61"
const expectedPatchBase = "3bf81461724d2261b51ec48900e86c89f8ce5e58"
const expectedTag = "v0.5.6-perf.6"
const expectedTagCommit = "225e532fe0caf0fe6db3b94cb5fe1510e3341e61"
const expectedVersion = "0.5.6-perf.6"
const expectedHashes = {
  core: "6363db3a01902d8f1f913d9f3f77c194d642d892c1936841da7314fe8df4b358",
  solid: "e2048bc99864f41c85dee9851a0203690c017c20e00383b272a32d8717aa224f",
  keymap: "c8bea2c5bbc1c8634f2ae5fd4adfd3b2380e9fc2aeca7add53934f0f39562a9e",
  native: "1a4e405c42642bacd32665029ff4ed0cf5be8655fe1d858d88f1f3416a5627d8",
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
      name: "keymap",
      source: path.join(source, "packages/keymap/dist"),
      target: await realpath(path.join(root, "packages/tui/node_modules/@opentui/keymap")),
      expected: expectedHashes.keymap,
    },
    {
      name: "native",
      source: path.join(source, "packages/core/node_modules/@opentui/core-linux-x64"),
      // Since the v0.5.5 native pkg move, core no longer optional-depends on
      // the platform package; the root devDependency link is the store slot.
      target: await realpath(path.join(root, "node_modules/@opentui/core-linux-x64")),
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
