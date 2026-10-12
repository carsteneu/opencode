#!/usr/bin/env bun

/**
 * Guards this branch's OpenTUI pin.
 *
 * Each branch pins exactly one OpenTUI fork release, published as GitHub release
 * tarballs of carsteneu/opentui: the v1 line and the v2 line must not drift into
 * each other's pin. EXPECTED_TAG is branch-specific on purpose, so a merge or a
 * rebase that carries the other line's pin fails here instead of quietly
 * resolving a different build.
 *
 * Usage: bun run script/check-opentui-pin.ts [--strict] [--remote]
 *
 * --strict  treat warnings as failures
 * --remote  also require the four release assets to answer HTTP 200
 */

import path from "node:path"

const EXPECTED_TAG = "v0.5.17-perf.5"

// "all": every native platform package is pinned to a tarball, so no platform
// falls back to a registry package. Export OPENTUI_PLATFORM_POLICY=linux-x64-only
// to relax it.
const PLATFORM_POLICY: "linux-x64-only" | "all" = process.env.OPENTUI_PLATFORM_POLICY === "linux-x64-only" ? "linux-x64-only" : "all"

const PINNED = [
  "@opentui/core",
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
  "@opentui/keymap",
  "@opentui/solid",
] as const
const URL_SHAPE = /^https:\/\/github\.com\/carsteneu\/opentui\/releases\/download\/(v[0-9][^/]*)\/([a-z0-9-]+)-([0-9][^/]*)\.tgz$/
const skip = new Set([".git", ".opencode", ".turbo", "dist", "node_modules"])

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const remote = args.includes("--remote")
const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--strict" && arg !== "--remote")
if (unknown) {
  console.error(`Unknown option: ${unknown}`)
  console.error("Usage: bun run script/check-opentui-pin.ts [--strict] [--remote]")
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "..")
const expected = (process.env.EXPECTED_OPENTUI_TAG || EXPECTED_TAG).replace(/^v/, "")

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

const isUrl = (value: string) => value.startsWith("http") || value.startsWith("file:")
const isLocal = (value: string) => value === "catalog:" || value.startsWith("workspace:") || isUrl(value)

// --- 1. the catalog carries the pinned release URLs, all on one tag -----------

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
  const expectBase = key.replace("@opentui/", "opentui-")
  if (value === undefined) {
    fail(`catalog has no entry for ${key}`)
    continue
  }
  const match = URL_SHAPE.exec(value)
  if (!match) {
    fail(`catalog entry for ${key} is not a carsteneu/opentui release tarball URL: ${value}`)
    continue
  }
  const [, urlTag, base, version] = match
  if (base !== expectBase) fail(`catalog entry for ${key} points at ${base}.tgz`)
  if (urlTag !== `v${expected}`) fail(`catalog entry for ${key} is on tag ${urlTag}, expected v${expected}`)
  if (version !== expected) fail(`catalog entry for ${key} has version ${version}, expected ${expected}`)
}
if (failures.length === 0) ok(`catalog pins ${PINNED.length} packages to v${expected}`)

// --- 2. no package.json resolves an @opentui dependency from the registry -----

const blocks = (json: Record<string, any>) =>
  [
    ["catalog", json.workspaces?.catalog ?? json.catalog],
    ["overrides", json.overrides],
    ["dependencies", json.dependencies],
    ["devDependencies", json.devDependencies],
    ["optionalDependencies", json.optionalDependencies],
  ] as const

for (const rel of manifestFiles) {
  const json = JSON.parse(await Bun.file(path.join(root, rel)).text())
  for (const [block, entries] of blocks(json)) {
    if (!entries || typeof entries !== "object") continue
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!key.startsWith("@opentui/") || typeof value !== "string" || isLocal(value)) continue
      fail(`${rel} ${block} resolves ${key} from the registry: "${value}"`)
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
  const match = URL_SHAPE.exec(locked)
  if (!match || match[1] !== `v${expected}`) {
    fail(`bun.lock catalog for ${key} is not on tag v${expected}: ${locked}`)
    continue
  }
  const entry = lock.packages?.[key]
  if (!Array.isArray(entry)) {
    fail(`bun.lock has no resolved entry for ${key}`)
    continue
  }
  if (!String(entry[0]).includes(locked)) fail(`bun.lock entry for ${key} does not resolve from its catalog URL`)
  if (typeof entry[2] !== "string" || !entry[2].startsWith("sha512-")) fail(`bun.lock entry for ${key} has no sha512 integrity`)
}
if (failures.length === 0) ok(`bun.lock resolves all ${PINNED.length} packages from v${expected} with sha512 integrity`)

for (const [key, entry] of Object.entries((lock.packages ?? {}) as Record<string, any>)) {
  const spec = Array.isArray(entry) ? String(entry[0]) : ""
  const match = /carsteneu\/opentui\/releases\/download\/(v[^/]+)\//.exec(spec)
  if (!match || match[1] === `v${expected}`) continue
  fail(`bun.lock package "${key}" resolves from tag ${match[1]}, expected v${expected}`)
}

// --- 4. platform packages that would come from the registry -------------------

const declared = (lock.packages?.["@opentui/core"]?.[1]?.optionalDependencies ?? {}) as Record<string, string>
const unpinned = Object.keys(declared).filter((key) => !lockCatalog[key])
if (unpinned.length > 0) {
  const names = (keys: string[]) => keys.map((key) => `${key}@${declared[key]}`).join(", ")
  const fromUpstream = unpinned.filter((key) => declared[key] !== expected)
  const unresolvable = unpinned.filter((key) => declared[key] === expected)
  const detail = [
    fromUpstream.length > 0
      ? `${names(fromUpstream)} resolve from the npm registry, where that version is an upstream release, so those platforms get a native package that is not this fork`
      : "",
    unresolvable.length > 0
      ? `${names(unresolvable)} cannot resolve at all, that version exists only as a GitHub release asset`
      : "",
  ]
    .filter(Boolean)
    .join("; ")
  const message = `${unpinned.length} of the ${Object.keys(declared).length} native platform packages are not pinned to a tarball: ${detail}`
  if (PLATFORM_POLICY === "all") fail(message)
  else warn(message)
} else if (Object.keys(declared).length > 0) {
  ok(`all ${Object.keys(declared).length} native platform packages are pinned`)
}

// --- 5. optionally require the release assets to be reachable -----------------

if (remote) {
  for (const key of PINNED) {
    const url = catalogEntries.get(key)
    if (!url || !URL_SHAPE.test(url)) continue
    const response = await fetch(url, { method: "HEAD", redirect: "follow" }).catch(() => undefined)
    const status = response?.status ?? 0
    if (status === 200) ok(`${key} asset answers 200`)
    else fail(`${key} asset answers ${status}`)
  }
}

// --- summary ------------------------------------------------------------------

console.log(`\nexpected release: v${expected} (branch-specific)`)
console.log(`platform policy: ${PLATFORM_POLICY}`)
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
