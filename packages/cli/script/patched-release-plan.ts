import semver from "semver"
import { isForkRelease, normalizeForkVersion } from "../src/services/updater-action"

export type KnownRelease = {
  readonly tagName: string
  readonly isDraft: boolean
  readonly isPrerelease: boolean
}

export type KnownDraft = {
  readonly isDraft: boolean
  readonly isPrerelease: boolean
  readonly targetCommitish: string
}

export type ReleasePlan =
  | { readonly action: "create" }
  | { readonly action: "resume" }
  | { readonly action: "refuse"; readonly reason: string }

/**
 * The guards that decide whether a fork prerelease may be built and published. They are
 * pure so they can be tested without a repository or GitHub; the release script only acts
 * on the result.
 */
export function planForkRelease(input: {
  readonly version: string
  readonly publish: boolean
  readonly releaseBranch: string
  readonly branch: string
  readonly worktree: string
  readonly packageVersion: string
  readonly releases: ReadonlyArray<KnownRelease>
  readonly existing: KnownDraft | undefined
  readonly head: string
}): ReleasePlan {
  if (!isForkRelease(input.version)) return refuse(`${input.version} is not an x.y.z-v2patched.n release`)
  const base = input.version.slice(0, input.version.indexOf("-v2patched."))
  if (base !== input.packageVersion)
    return refuse(`Release base ${base} does not match packages/cli version ${input.packageVersion}`)
  if (input.publish && input.branch !== input.releaseBranch)
    return refuse(`Fork releases must be published from ${input.releaseBranch}, got ${input.branch}`)
  if (input.publish && input.worktree)
    return refuse(`Worktree must be clean before publishing:\n${input.worktree}`)

  const published = newestPublished(input.releases)
  if (published && !semver.gt(input.version, published))
    return refuse(`Release ${input.version} must be newer than the current fork prerelease ${published}`)

  if (input.existing) {
    if (!input.existing.isDraft)
      return refuse(
        `Published release ${input.version} already exists. Publish ${nextForkVersion(input.version)} instead: ` +
          `installs only move forward by version number, so reusing one leaves every client that already has it behind.`,
      )
    if (input.existing.targetCommitish !== input.head || !input.existing.isPrerelease)
      return refuse(`Existing draft does not match this release: ${JSON.stringify(input.existing)}`)
    return { action: "resume" }
  }
  return { action: "create" }
}

export function newestPublished(releases: ReadonlyArray<KnownRelease>): string | undefined {
  return releases
    .filter((release) => !release.isDraft && release.isPrerelease)
    .map((release) => normalizeForkVersion(release.tagName))
    .filter((tag) => isForkRelease(tag))
    .sort(semver.rcompare)[0]
}

export function nextForkVersion(version: string): string {
  const counter = Number(version.slice(version.lastIndexOf(".") + 1))
  const base = version.slice(0, version.indexOf("-v2patched."))
  return Number.isSafeInteger(counter) ? `${base}-v2patched.${counter + 1}` : `${base}-v2patched.1`
}

function refuse(reason: string): ReleasePlan {
  return { action: "refuse", reason }
}
