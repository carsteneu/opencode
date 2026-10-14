import { describe, expect, test } from "bun:test"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

/**
 * The published channel is shared with the frozen 1.x line, which reads it with its
 * own hardcoded tag fence and asset name. Those two constants are the contract this
 * release shape has to satisfy, and 1.x is read-only — so they are read from the real
 * 1.x source instead of being copied here. A change to the 1.x fence has to fail this
 * test rather than silently disconnect the shared channel.
 */
function v1Source() {
  const refs = ["working", "fork/working", "origin/working"]
  const ref = refs.find(
    (candidate) => Bun.spawnSync(["git", "rev-parse", "--verify", `${candidate}^{commit}`], { cwd: root }).exitCode === 0,
  )
  if (!ref) throw new Error(`Cannot find the 1.x release branch; tried ${refs.join(", ")}`)
  const result = Bun.spawnSync(["git", "show", `${ref}:packages/opencode/src/installation/index.ts`], { cwd: root })
  if (result.exitCode !== 0)
    throw new Error(`Cannot read the 1.x installer from ${ref}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function v1Fence() {
  const line = v1Source()
    .split("\n")
    .find((line) => line.includes("const PATCHED_RELEASE ="))
  const source = line?.match(/const PATCHED_RELEASE = \/(.+)\/$/)?.[1]
  if (!source) throw new Error("Could not extract PATCHED_RELEASE from the 1.x source")
  return new RegExp(source)
}

function v1AssetName() {
  const source = v1Source().match(/function patchedAssetName\(\)[\s\S]*?return "([^"]+)"/)?.[1]
  if (!source) throw new Error("Could not extract patchedAssetName from the 1.x source")
  return source
}

/** The 1.x selector, applied with 1.x's own filters, over a release listing. */
function v1Select(releases: ReadonlyArray<{ tag_name: string; draft: boolean; prerelease: boolean; assets: ReadonlyArray<{ name: string }> }>) {
  const fence = v1Fence()
  const asset = v1AssetName()
  return releases
    .filter((release) => !release.draft && release.prerelease)
    .filter((release) => fence.test(release.tag_name))
    .filter((release) => release.assets.some((item) => item.name === asset))
    .filter((release) => release.assets.some((item) => item.name === `${asset}.sha256`))
    .map((release) => fence.exec(release.tag_name)![1]!)
}

const release = (tag: string, assets: ReadonlyArray<string>) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  assets: assets.map((name) => ({ name })),
})

const retiredMarker = `v2${ForkRelease.channel}`

describe("the release shape is the shared channel between the 1.x and 2.x lines", () => {
  test("a published 2.x tag satisfies the frozen 1.x tag fence", () => {
    const fence = v1Fence()
    expect(fence.test("2.0.26-patched.1")).toBe(true)
    expect(fence.test("v2.0.26-patched.1")).toBe(true)
    // ...and the 1.x line's own releases stay on it, which is what makes the
    // channel shared instead of duplicated.
    expect(fence.test("1.18.34-patched.220")).toBe(true)
  })

  test("the asset pair is exactly the one the frozen 1.x line selects", () => {
    expect(ForkRelease.asset("linux", "x64")).toBe(v1AssetName())
    expect(ForkRelease.checksumAsset(ForkRelease.asset("linux", "x64")!)).toBe(`${v1AssetName()}.sha256`)
  })

  test("the 1.x selector accepts a published 2.x release out of a mixed listing", () => {
    const asset = ForkRelease.asset()
    if (!asset) return
    const listing = [
      release("1.18.34-patched.220", [asset, `${asset}.sha256`]),
      release("1.18.32-patched.172", [asset, `${asset}.sha256`]),
      release("2.0.26-patched.1", [asset, `${asset}.sha256`]),
    ]
    const accepted = v1Select(listing)
    expect(accepted).toContain("2.0.26-patched.1")
    // 1.x ranks the accepted list with semver.rcompare, which orders by major
    // number first. Ours carries the highest major, so 1.x installs it.
    expect(Math.max(...accepted.map((tag) => Number(tag.split(".")[0])))).toBe(2)
  })

  test("the retired v2patched shape is reachable from neither client", () => {
    const asset = ForkRelease.asset()
    if (!asset) return
    const retired = [
      release("2.0.26-v2patched.1", [`opencode-v2-linux-x64`, `opencode-v2-linux-x64.sha256`]),
      release("2.0.26-v2patched.2", [`opencode-v2-linux-x64`, `opencode-v2-linux-x64.sha256`]),
    ]
    // The 1.x fence does not match it, and the 2.x contract does not either, so the
    // four stale prereleases were dead weight for every client.
    expect(v1Select(retired)).toEqual([])
    expect(retired.every((item) => ForkRelease.version(item.tag_name) === undefined)).toBe(true)
    expect(retired.every((item) => !v1Fence().test(item.tag_name))).toBe(true)
  })

  test("the contract does not carry the retired marker anywhere", () => {
    expect(ForkRelease.channel).not.toContain(retiredMarker)
    expect(ForkRelease.asset()).not.toContain(retiredMarker)
    expect(ForkRelease.version("2.0.26-v2patched.1")).toBeUndefined()
  })
})
