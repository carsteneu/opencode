#!/usr/bin/env bun

/**
 * Guards this branch's OpenTUI version.
 *
 * The v2 line uses a stock OpenTUI release, not a fork build: one version in one place (the catalog of the
 * root manifest), and nothing that resolves an @opentui package from a fork tarball. That is what this
 * check protects, because a merge or a rebase from the v1 line still carries the old fork pins and they
 * resolve quietly instead of failing loudly.
 *
 * Usage: bun run script/check-opentui-pin.ts [--strict]
 *
 * --strict  treat warnings as failures
 */

import path from "node:path"

const EXPECTED_VERSION = "0.6.6"

const PINNED = ["@opentui/core", "@opentui/keymap", "@opentui/solid"] as const
const FORK_TARBALL = /github\.com\/carsteneu\/opentui\/releases\/download\//
const skip = new Set([".git", ".opencode", ".turbo", "dist", "node_modules"])

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--strict")
if (unknown) {
  console.error(`Unknown option: ${unknown}`)
  console.error("Usage: bun run script/check-opentui-pin.ts [--strict]")
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "..")
const expected = process.env.EXPECTED_OPENTUI_VERSION || EXPECTED_VERSION

const failures: string[] = []
const warnings: string[] = []
const ok = (msg: string) => console.log(`ok   ${msg}`)
const fail = (msg: string) => {
  failures.push(msg)
  console.error(`FAIL ${msg}`)
}
const warn = (msg: string) => {
  warnings.push(msg)
  console.warn(`warn ${msg}`)
}

const manifestFiles = (await Array.fromAsync(new Bun.Glob("**/package.json").scan({ cwd: root }))).filter(
  (file) => !file.split("/").some((part) => skip.has(part)),
)

const isLocal = (value: string) => value === "catalog:" || value.startsWith("workspace:")

// --- 1. the catalog names one stock version, and it is the expected one -------

const catalogEntries = new Map<string, string>()
for (const rel of manifestFiles) {
  const json = JSON.parse(await Bun.file(path.join(root, rel)).text())
  const catalog = json.workspaces?.catalog ?? json.catalog
  if (!catalog || typeof catalog !== "object") continue
  for (const key of PINNED) {
    const value = (catalog as Record<string, unknown>)[key]
    if (typeof value === "string") catalogEntries.set(key, value)
  }
}

for (const key of PINNED) {
  const value = catalogEntries.get(key)
  if (value === undefined) {
    fail(`catalog has no entry for ${key}`)
    continue
  }
  if (FORK_TARBALL.test(value) || value.startsWith("file:") || value.startsWith("link:")) {
    fail(`catalog entry for ${key} resolves a fork build instead of the stock release: ${value}`)
    continue
  }
  if (value !== expected) fail(`catalog entry for ${key} is ${value}, expected ${expected}`)
}
if (failures.length === 0) ok(`catalog pins ${PINNED.length} packages to ${expected}`)

// --- 2. every manifest takes the version from the catalog ---------------------

const blocks = (json: Record<string, any>) =>
  [
    ["overrides", json.overrides],
    ["dependencies", json.dependencies],
    ["devDependencies", json.devDependencies],
    ["optionalDependencies", json.optionalDependencies],
  ] as const
// peerDependencies are ranges on purpose: a library states compatibility, it does not pin the build.

for (const rel of manifestFiles) {
  const json = JSON.parse(await Bun.file(path.join(root, rel)).text())
  for (const [block, entries] of blocks(json)) {
    if (!entries || typeof entries !== "object") continue
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!key.startsWith("@opentui/") || typeof value !== "string") continue
      if (FORK_TARBALL.test(value)) fail(`${rel} ${block} pins ${key} to a fork tarball: ${value}`)
      else if (!isLocal(value)) fail(`${rel} ${block} pins ${key} to "${value}" instead of taking it from the catalog`)
    }
  }
  const peers = json.peerDependencies
  if (peers && typeof peers === "object") {
    for (const [key, value] of Object.entries(peers as Record<string, unknown>)) {
      if (!key.startsWith("@opentui/") || typeof value !== "string" || isLocal(value)) continue
      ok(`${rel} declares peer ${key} "${value}"`)
    }
  }
}

// --- 3. the lockfile agrees with the manifests --------------------------------

const lock = Bun.JSONC.parse(await Bun.file(path.join(root, "bun.lock")).text()) as Record<string, any>
const lockCatalog = (lock.catalog ?? {}) as Record<string, string>

for (const key of PINNED) {
  const manifest = catalogEntries.get(key)
  const locked = lockCatalog[key]
  if (locked === undefined) {
    fail(`bun.lock catalog has no entry for ${key}`)
    continue
  }
  if (manifest !== undefined && locked !== manifest) {
    fail(`bun.lock catalog for ${key} differs from package.json: ${locked} vs ${manifest}`)
    continue
  }
  if (locked !== expected) {
    fail(`bun.lock catalog for ${key} is ${locked}, expected ${expected}`)
    continue
  }
  const entry = lock.packages?.[key]
  if (!Array.isArray(entry)) {
    fail(`bun.lock has no resolved entry for ${key}`)
    continue
  }
  const spec = String(entry[0])
  if (spec !== `${key}@${expected}`) fail(`bun.lock entry for ${key} resolves ${spec}, expected ${key}@${expected}`)
}
if (failures.length === 0) ok(`bun.lock resolves all ${PINNED.length} packages to ${expected}`)

// --- 4. nothing anywhere still resolves from the v1 fork tarballs -------------

for (const [key, entry] of Object.entries((lock.packages ?? {}) as Record<string, any>)) {
  const spec = Array.isArray(entry) ? String(entry[0]) : ""
  if (FORK_TARBALL.test(spec)) fail(`bun.lock package "${key}" still resolves from a fork tarball: ${spec}`)
}
for (const [key, entry] of Object.entries((lock.overrides ?? {}) as Record<string, unknown>)) {
  if (key.startsWith("@opentui/") && typeof entry === "string" && FORK_TARBALL.test(entry))
    fail(`bun.lock overrides pins ${key} to a fork tarball: ${entry}`)
}

// --- summary ------------------------------------------------------------------

console.log(`\nexpected version: ${expected}`)
if (warnings.length > 0) console.log(`warnings: ${warnings.length}${strict ? " (strict: treated as failures)" : ""}`)
if (failures.length > 0) {
  console.error(`\nopenTUI pin check failed with ${failures.length} error(s)`)
  process.exit(1)
}
if (strict && warnings.length > 0) {
  console.error(`\nopenTUI pin check failed in strict mode with ${warnings.length} warning(s)`)
  process.exit(1)
}
console.log("\nopenTUI pin check passed")
