import { describe, expect, test } from "bun:test"
import path from "node:path"
import semver from "semver"
import {
  FORK_RELEASE_PATTERN,
  canUpgradeToTarget,
  forkAssetName,
  isForkRelease,
  normalizeForkVersion,
  selectForkRelease,
  type ForkRelease,
} from "../src/services/updater-action"

const root = path.resolve(import.meta.dir, "../../..")
const V1_ASSET = "opencode-linux-x64"
const V2_ASSET = "opencode-v2-linux-x64"

/**
 * The v1 line refuses patched -> non-patched upgrades with its own pattern. v1 is
 * read-only, so this reads the real constant instead of copying it: the crossing proof
 * has to fail if v1's fence ever changes.
 */
function v1PatchedPattern() {
  const refs = ["working", "fork/working", "origin/working"]
  const ref = refs.find(
    (candidate) =>
      Bun.spawnSync(["git", "rev-parse", "--verify", `${candidate}^{commit}`], { cwd: root }).exitCode === 0,
  )
  if (!ref) throw new Error(`Cannot find the v1 release branch; tried ${refs.join(", ")}`)
  const result = Bun.spawnSync(["git", "show", `${ref}:packages/opencode/src/installation/index.ts`], {
    cwd: root,
  })
  if (result.exitCode !== 0)
    throw new Error(`Cannot read the v1 fence from ${ref}: ${result.stderr.toString().trim()}`)
  const line = result.stdout
    .toString()
    .split("\n")
    .find((line) => line.includes("const PATCHED_RELEASE ="))
  const source = line?.match(/const PATCHED_RELEASE = \/(.+)\/$/)?.[1]
  if (!source) throw new Error("Could not extract PATCHED_RELEASE from the v1 source")
  return new RegExp(source)
}

function release(tag: string, assets: string[], extra: Partial<ForkRelease> = {}): ForkRelease {
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.invalid/${tag}/${name}` })),
    ...extra,
  }
}

describe("fork release version schema", () => {
  test("orders fork prereleases by their counter", () => {
    expect(semver.gt("2.0.26-v2patched.2", "2.0.26-v2patched.1")).toBe(true)
    expect(semver.gt("2.0.26-v2patched.10", "2.0.26-v2patched.9")).toBe(true)
    expect(semver.lt("2.0.26-v2patched.1", "2.0.27-v2patched.1")).toBe(true)
  })

  test("sorts below the stable release of its own base, so the base must track upstream", () => {
    expect(semver.lt("2.0.26-v2patched.1", "2.0.26")).toBe(true)
    expect(semver.gt("2.0.26-v2patched.1", "2.0.25")).toBe(true)
  })

  test("outranks the v1 patched line, and the v1 line cannot reach it", () => {
    expect(semver.gt("2.0.26-v2patched.1", "1.18.34-patched.220")).toBe(true)
  })

  test("accepts only x.y.z-v2patched.n", () => {
    expect(isForkRelease("2.0.26-v2patched.1")).toBe(true)
    expect(isForkRelease("v2.0.26-v2patched.1")).toBe(true)
    expect(isForkRelease(" 2.0.26-v2patched.1 ")).toBe(true)
    expect(normalizeForkVersion("v2.0.26-v2patched.1")).toBe("2.0.26-v2patched.1")
    for (const value of [
      "2.0.26",
      "1.18.34-patched.220",
      "2.0.26-v2patched",
      "2.0.26-v2patched.x",
      "2.0.26-v2-patched.1",
      "0.0.0-v2-release-path-202610141222",
    ])
      expect(isForkRelease(value), value).toBe(false)
  })

  test("does not cross the v1 fence in either direction", () => {
    const v1 = v1PatchedPattern()
    expect(v1.test("2.0.26-v2patched.1")).toBe(false)
    expect(v1.test("2.0.26-v2patched.220")).toBe(false)
    expect(v1.test("1.18.34-patched.220")).toBe(true)
    expect(FORK_RELEASE_PATTERN.test("1.18.34-patched.220")).toBe(false)
    expect(FORK_RELEASE_PATTERN.test("1.18.25-patched.170")).toBe(false)
  })

  test("rejects reusing the v1 identifier, which the v1 fence would match", () => {
    const v1 = v1PatchedPattern()
    // The fence is anchored, so only a tag whose prerelease is exactly `patched.<n>`
    // crosses. Our distinct token is what keeps the two lines apart.
    expect(v1.test("2.0.26-patched.1")).toBe(true)
    expect(v1.test("2.0.26-v2patched.1")).toBe(false)
    expect(v1.test("2.0.26-v2-patched.1")).toBe(false)
    expect(FORK_RELEASE_PATTERN.test("2.0.26-patched.1")).toBe(false)
  })

  test("a v1 selector over the real release list never returns a v2 release", () => {
    const v1 = v1PatchedPattern()
    const releases = [
      release("1.18.32-patched.172", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("1.18.34-patched.220", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("1.18.27-patched.170", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("2.0.26-v2patched.1", [V2_ASSET, `${V2_ASSET}.sha256`]),
      release("2.0.26-v2patched.9", [V2_ASSET, `${V2_ASSET}.sha256`]),
    ]
    const selected = releases
      .filter((item) => !item.draft && item.prerelease)
      .filter((item) => v1.test(item.tag_name))
      .filter((item) => item.assets.some((asset) => asset.name === V1_ASSET))
      .filter((item) => item.assets.some((asset) => asset.name === `${V1_ASSET}.sha256`))
      .sort((a, b) => semver.rcompare(a.tag_name.replace(/^v/, ""), b.tag_name.replace(/^v/, "")))[0]
    expect(selected?.tag_name).toBe("1.18.34-patched.220")
  })
})

describe("canUpgradeToTarget", () => {
  test("a fork build only upgrades to fork prereleases", () => {
    expect(canUpgradeToTarget("2.0.26-v2patched.1", "2.0.26-v2patched.2")).toBe(true)
    expect(canUpgradeToTarget("2.0.26-v2patched.1", "v2.0.26-v2patched.2")).toBe(true)
    expect(canUpgradeToTarget("2.0.26-v2patched.1", "2.0.27")).toBe(false)
    expect(canUpgradeToTarget("2.0.26-v2patched.1", "2.0.26")).toBe(false)
    expect(canUpgradeToTarget("2.0.26-v2patched.1", "1.18.34-patched.220")).toBe(false)
  })

  test("a stock build keeps its unrestricted upgrade path", () => {
    expect(canUpgradeToTarget("2.0.26", "2.0.27")).toBe(true)
    expect(canUpgradeToTarget("local", "2.0.27")).toBe(true)
    expect(canUpgradeToTarget("1.18.34", "1.18.35")).toBe(true)
  })
})

describe("selectForkRelease", () => {
  test("picks the highest fork prerelease that carries both assets", () => {
    const releases = [
      release("1.18.34-patched.220", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("2.0.26-v2patched.1", [V2_ASSET, `${V2_ASSET}.sha256`]),
      release("2.0.26-v2patched.7", [V2_ASSET, `${V2_ASSET}.sha256`]),
      release("2.0.26-v2patched.3", [V2_ASSET, `${V2_ASSET}.sha256`]),
    ]
    expect(selectForkRelease(releases, V2_ASSET)?.tag_name).toBe("2.0.26-v2patched.7")
  })

  test("ignores drafts, stable releases, foreign tags and incomplete assets", () => {
    const releases = [
      release("2.0.26-v2patched.9", [V2_ASSET, `${V2_ASSET}.sha256`], { draft: true }),
      release("2.0.26-v2patched.8", [V2_ASSET, `${V2_ASSET}.sha256`], { prerelease: false }),
      release("2.0.27", [V2_ASSET, `${V2_ASSET}.sha256`], { prerelease: false }),
      release("1.18.34-patched.220", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("2.0.26-v2patched.7", [V2_ASSET]),
      release("2.0.26-v2patched.6", [`${V2_ASSET}.sha256`]),
      release("2.0.26-v2patched.5", [V2_ASSET, `${V2_ASSET}.sha256`]),
    ]
    expect(selectForkRelease(releases, V2_ASSET)?.tag_name).toBe("2.0.26-v2patched.5")
  })

  test("a v2 selector never returns a v1 release even when it is the newest", () => {
    const releases = [
      release("1.18.34-patched.220", [V1_ASSET, `${V1_ASSET}.sha256`]),
      release("2.0.26-v2patched.1", [V2_ASSET, `${V2_ASSET}.sha256`]),
    ]
    expect(selectForkRelease(releases, V2_ASSET)?.tag_name).toBe("2.0.26-v2patched.1")
    // A v1 selector over the same list must not see the v2 asset at all.
    expect(selectForkRelease(releases, V1_ASSET)).toBeUndefined()
  })

  test("returns nothing without a supported asset", () => {
    const releases = [release("2.0.26-v2patched.1", [V2_ASSET, `${V2_ASSET}.sha256`])]
    expect(selectForkRelease(releases, undefined)).toBeUndefined()
    expect(forkAssetName("linux", "x64")).toBe(V2_ASSET)
    expect(forkAssetName("linux", "arm64")).toBeUndefined()
    expect(forkAssetName("darwin", "x64")).toBeUndefined()
    expect(forkAssetName("win32", "x64")).toBeUndefined()
  })
})
