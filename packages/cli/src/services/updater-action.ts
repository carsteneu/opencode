export type Policy = "disable" | "notify" | "auto"
export type Action = "none" | "notify" | "auto"

const maximumComponent = "9007199254740991"
const versionPattern =
  /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === "disable") return "none"
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion || sameRelease(currentVersion, latestVersion)) return "none"
  // Major releases are never installed automatically; only the explicit
  // transfer (`opencode upgrade --major`) crosses a major boundary.
  if (currentVersion.major !== latestVersion.major) return "none"
  return policy
}

/** True when `latest` names a different release than `current`. */
export function updates(current: string, latest: string) {
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion) return false
  return !sameRelease(currentVersion, latestVersion)
}

/** True when the two versions belong to different major lines. */
export function majorChange(current: string, latest: string) {
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion) return false
  return currentVersion.major !== latestVersion.major
}

/** Ranks two release versions; undefined when either is not one. */
export function compareRelease(left: string, right: string) {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return undefined
  const components = (value: typeof a) => value.core.split(".").map(Number)
  const [aCore, bCore] = [components(a), components(b)]
  for (let index = 0; index < 3; index++) {
    if (aCore[index] !== bCore[index]) return aCore[index] > bCore[index] ? 1 : -1
  }
  const length = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]]
    if (x === y) continue
    const numeric = /^[0-9]+$/.test(x) && /^[0-9]+$/.test(y)
    // semver coerces oversized numeric identifiers, and sameRelease does the
    // same, so the ranking must not disagree with the equality check.
    if (numeric) {
      const [left, right] = [Number(x), Number(y)]
      return left === right ? 0 : left > right ? 1 : -1
    }
    if (/^[0-9]+$/.test(x)) return -1
    if (/^[0-9]+$/.test(y)) return 1
    return x > y ? 1 : -1
  }
  if (a.prerelease.length !== b.prerelease.length) return a.prerelease.length > b.prerelease.length ? 1 : -1
  return 0
}

/**
 * True only when `latest` is strictly newer than `current`. "Different" is not
 * "newer": a release on an older line is not an update, and announcing it would
 * offer a download the installer then refuses.
 */
export function newerRelease(current: string, latest: string) {
  const order = compareRelease(latest, current)
  return order !== undefined && order > 0
}

/**
 * The version a binary reports for itself. A released 2.x CLI prints the bare version
 * (`2.0.26-patched.1`) because the frozen 1.x installer compares the probe output verbatim;
 * a patched 1.x CLI prints `opencode v1.18.34-patched.219`. Both are read as "the last token
 * without its leading v", so a binary from either line reports the same way. The release
 * pipeline and the updater have to read it the same way, or the pipeline can publish a
 * binary the updater then refuses.
 */
export function reportedVersion(output: string) {
  return output.trim().split(/\s+/).at(-1)?.replace(/^v/, "") ?? ""
}

/**
 * What an automatic check may do with `latest`:
 * - `none` when it is not a strictly newer release - an older release announced as
 *   available is a download the installer then refuses - or when the policy forbids it;
 * - `install` only under the auto policy and only within the same major line;
 * - `announce` otherwise, so a `notify` install is still told about the major change it
 *   has to move through deliberately, instead of that being the one update never shown.
 */
export function automaticAction(current: string, latest: string, policy: Policy): "none" | "announce" | "install" {
  if (!newerRelease(current, latest)) return "none"
  const decision = action(current, latest, policy)
  if (decision === "auto") return "install"
  if (decision === "notify") return "announce"
  return policy === "notify" ? "announce" : "none"
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
