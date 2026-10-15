import { describe, expect, test } from "bun:test"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

/**
 * The published channel is shared with the frozen 1.x line, which reads it with its own
 * hardcoded tag fence, asset name and version probe. Those are the contract this release
 * shape has to satisfy, and 1.x is read-only - so they are read from the real 1.x source
 * instead of being copied here. A change on the 1.x side has to fail this test rather than
 * silently disconnect the shared channel.
 */
function v1Ref() {
  const refs = ["working", "fork/working", "origin/working"]
  return refs.find(
    (candidate) => Bun.spawnSync(["git", "rev-parse", "--verify", `${candidate}^{commit}`], { cwd: root }).exitCode === 0,
  )
}

const ref = v1Ref()

function v1Source() {
  if (!ref) throw new Error("the 1.x release ref is missing from this checkout")
  const result = Bun.spawnSync(["git", "show", `${ref}:packages/opencode/src/installation/index.ts`], { cwd: root })
  if (result.exitCode !== 0) throw new Error(`Cannot read the 1.x installer from ${ref}: ${result.stderr.toString().trim()}`)
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

/** The 1.x selector: its tag fence and its asset filters, applied to a release listing. */
function v1Select(
  releases: ReadonlyArray<{
    tag_name: string
    draft: boolean
    prerelease: boolean
    assets: ReadonlyArray<{ name: string }>
  }>,
) {
  const fence = v1Fence()
  const asset = v1AssetName()
  return releases
    .filter((release) => !release.draft && release.prerelease)
    .filter((release) => fence.test(release.tag_name))
    .filter((release) => release.assets.some((item) => item.name === asset))
    .filter((release) => release.assets.some((item) => item.name === `${asset}.sha256`))
    .map((release) => fence.exec(release.tag_name)![1]!)
}

/**
 * The frozen 1.x installer probes the downloaded asset with exactly this comparison
 * (1.x: `smoke.stdout.trim().replace(/^v/, "") !== normalizedTarget`). Modelled rather than
 * extracted because the expression sits inside a longer condition; the anchor test below
 * fails if the real expression ever changes.
 */
const v1ProbeAccepts = (output: string, target: string) => output.trim().replace(/^v/, "") === target

const release = (tag: string, assets: ReadonlyArray<string>) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  assets: assets.map((name) => ({ name })),
})

const retiredMarker = `v2${ForkRelease.channel}`

describe("the contract does not carry the retired marker", () => {
  test("neither the channel nor the asset name mentions it", () => {
    expect(ForkRelease.channel).not.toContain(retiredMarker)
    expect(ForkRelease.asset()).not.toContain(retiredMarker)
    expect(ForkRelease.version("2.0.26-v2patched.1")).toBeUndefined()
  })

  test("the published shape is the one the mandate names", () => {
    expect(ForkRelease.channel).toBe("patched")
    expect(ForkRelease.asset("linux", "x64")).toBe("opencode-linux-x64")
    expect(ForkRelease.version("2.0.26-patched.1")).toBe("2.0.26-patched.1")
  })
})

describe.skipIf(ref === undefined)(`the shared channel against the frozen 1.x line (${ref})`, () => {
  test("a published 2.x tag satisfies the 1.x tag fence", () => {
    const fence = v1Fence()
    expect(fence.test("2.0.26-patched.1")).toBe(true)
    expect(fence.test("v2.0.26-patched.1")).toBe(true)
    // ...and 1.x's own releases stay on it, which is what makes the channel shared.
    expect(fence.test("1.18.34-patched.220")).toBe(true)
  })

  test("the asset pair is exactly the one the 1.x line selects", () => {
    const asset = ForkRelease.asset("linux", "x64")!
    expect(asset).toBe(v1AssetName())
    expect(ForkRelease.checksumAsset(asset)).toBe(`${v1AssetName()}.sha256`)
  })

  test("the 1.x selector accepts a published 2.x release out of a mixed listing", () => {
    const asset = ForkRelease.asset()
    if (!asset) return
    const accepted = v1Select([
      release("1.18.34-patched.220", [asset, `${asset}.sha256`]),
      release("1.18.32-patched.172", [asset, `${asset}.sha256`]),
      release("2.0.26-patched.1", [asset, `${asset}.sha256`]),
    ])
    expect(accepted).toContain("2.0.26-patched.1")
    // 1.x ranks the accepted list with semver.rcompare, which orders by major number
    // first. Ours carries the highest major, so 1.x selects it.
    expect(Math.max(...accepted.map((tag) => Number(tag.split(".")[0])))).toBe(2)
  })

  test("the retired v2patched shape is reachable from neither client", () => {
    const asset = ForkRelease.asset()
    if (!asset) return
    const retired = [
      release("2.0.26-v2patched.1", ["opencode-v2-linux-x64", "opencode-v2-linux-x64.sha256"]),
      release("2.0.26-v2patched.2", ["opencode-v2-linux-x64", "opencode-v2-linux-x64.sha256"]),
    ]
    expect(v1Select(retired)).toEqual([])
    expect(retired.every((item) => ForkRelease.version(item.tag_name) === undefined)).toBe(true)
    expect(retired.every((item) => !v1Fence().test(item.tag_name))).toBe(true)
  })

  test("the modelled 1.x probe still matches the real 1.x expression", () => {
    // If this fails, the model above is stale and the next test proves nothing.
    expect(v1Source()).toContain('smoke.stdout.trim().replace(/^v/, "") !== normalizedTarget')
  })

  test("the 2.x version banner does not satisfy the 1.x probe (known blocker)", () => {
    // 1.x accepts the bare version it prints itself...
    expect(v1ProbeAccepts("1.18.34-patched.219", "1.18.34-patched.219")).toBe(true)
    // ...but the 2.x CLI renders "opencode v2.0.26-patched.1", so the transfer reaches
    // its last step and fails with "Patched release binary verification failed.".
    // This test fails the moment the 2.x banner becomes consumable by 1.x - which is
    // the signal that the blocker is resolved and the docs must drop the caveat.
    expect(v1ProbeAccepts("opencode v2.0.26-patched.1", "2.0.26-patched.1")).toBe(false)
  })
})
