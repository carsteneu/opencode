import semver from "semver"

export type Policy = "disable" | "notify" | "auto"
export type Action = "none" | "notify" | "auto"

// Fork releases are `x.y.z-v2patched.n` prereleases on carsteneu/opencode. Keep the
// identifier a single token: `x.y.z-v2-patched.n` contains `-patched.` and would be
// selected by the v1 fence `/^\d+\.\d+\.\d+-patched\.\d+$/`, crossing the two lines.
export const FORK_RELEASE_PATTERN = /^v?(\d+\.\d+\.\d+-v2patched\.\d+)$/

export function isForkRelease(input: string): boolean {
  return FORK_RELEASE_PATTERN.test(input.trim())
}

export function normalizeForkVersion(input: string): string {
  const value = input.trim()
  return value.match(FORK_RELEASE_PATTERN)?.[1] ?? value.replace(/^v/, "")
}

/** `opencode --version` prints `opencode v1.2.3`; the version is the whole string. */
export function reportedVersion(output: string): string {
  return output
    .trim()
    .replace(/^opencode\s+/, "")
    .replace(/^v/, "")
}

/**
 * A fork build must only ever move to another fork prerelease. The official release
 * service must not replace a fork install: `action` below only compares versions for
 * equality, so any differing official version is already an upgrade candidate.
 */
export function canUpgradeToTarget(current: string, target: string): boolean {
  if (!isForkRelease(current)) return true
  return isForkRelease(target)
}

export type ForkAsset = { readonly name: string; readonly browser_download_url: string }
export type ForkRelease = {
  readonly tag_name: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly assets: ReadonlyArray<ForkAsset>
}

/**
 * The fork binary is Linux x64 only (the v1 patched release has the same limit).
 * Asset names are deliberately different from v1's `opencode-linux-x64` so a v1
 * selector cannot match a v2 release even if a tag pattern were ever relaxed.
 */
export function forkAssetName(platform = process.platform, arch = process.arch): string | undefined {
  if (platform !== "linux" || arch !== "x64") return undefined
  return "opencode-v2-linux-x64"
}

export function selectForkRelease(
  releases: ReadonlyArray<ForkRelease>,
  asset: string | undefined,
): ForkRelease | undefined {
  if (!asset) return undefined
  return releases
    .filter((release) => !release.draft && release.prerelease)
    .filter((release) => FORK_RELEASE_PATTERN.test(release.tag_name))
    .filter((release) => release.assets.some((item) => item.name === asset))
    .filter((release) => release.assets.some((item) => item.name === `${asset}.sha256`))
    .sort((a, b) => semver.rcompare(normalizeForkVersion(a.tag_name), normalizeForkVersion(b.tag_name)))[0]
}

const maximumComponent = "9007199254740991"
const versionPattern =
  /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === "disable") return "none"
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion || sameRelease(currentVersion, latestVersion)) return "none"
  return policy
}

export function parseReleaseVersion(input: string) {
  if (input.length > 256) return
  const match = input.trim().match(versionPattern)
  if (!match) return
  if ([match[1], match[2], match[3]].some(invalidComponent)) return
  if (
    match[4]
      ?.split(".")
      .some((identifier) => identifier.length > 1 && identifier.startsWith("0") && /^[0-9]+$/.test(identifier))
  )
    return
  return {
    major: match[1],
    core: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4]?.split(".") ?? [],
  }
}

function sameRelease(current: NonNullable<ReturnType<typeof parseReleaseVersion>>, latest: typeof current) {
  if (current.core !== latest.core || current.prerelease.length !== latest.prerelease.length) return false
  return current.prerelease.every((identifier, index) => {
    const other = latest.prerelease[index]
    if (identifier === other) return true
    // semver compares oversized numeric prerelease identifiers after numeric coercion.
    return /^[0-9]+$/.test(identifier) && /^[0-9]+$/.test(other) && Number(identifier) === Number(other)
  })
}

function invalidComponent(value: string) {
  if (value.length > 1 && value.startsWith("0")) return true
  if (value.length !== maximumComponent.length) return value.length > maximumComponent.length
  return value > maximumComponent
}
