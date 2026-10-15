import { ForkRelease } from "@opencode/util/installation/fork-release"
import { compareRelease } from "../src/services/updater-action"

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
 * The guards that decide whether a patched prerelease may be built and published. They are
 * pure so they can be tested without a repository or GitHub; the release script only acts
 * on the result.
 *
 * Tag shape, channel and the ordering of published versions all come from the release
 * contract, so the pipeline cannot drift from what the clients select. Ordering uses the
 * client's own comparator for the same reason: a release the pipeline ranks as newer has
 * to be one the clients would install.
 *
 * A publish has two admissible identities: the release branch (a manual run) and the tag
 * that names exactly the version being released (the tag-push route).
 */
export function planForkRelease(input: {
  readonly version: string
  readonly publish: boolean
  readonly releaseBranch: string
  readonly branch: string
  /**
   * The release tag this run is checked out at, normalised through the contract, or
   * undefined when the run is not driven by a tag. A tag push checks out a detached HEAD,
   * so the tag in its own right - not a branch - is the release identity there.
   */
  readonly tag: string | undefined
  readonly worktree: string
  readonly packageVersion: string
  readonly releases: ReadonlyArray<KnownRelease>
  readonly existing: KnownDraft | undefined
  readonly head: string
}): ReleasePlan {
  if (!ForkRelease.version(input.version))
    return refuse(`${input.version} is not an x.y.z-${ForkRelease.channel}.n release`)
  const base = releaseBase(input.version)
  if (base !== input.packageVersion)
    return refuse(`Release base ${base} does not match packages/cli version ${input.packageVersion}`)
  if (input.publish && input.branch !== input.releaseBranch && input.tag !== input.version)
    return refuse(
      `Fork releases must be published from ${input.releaseBranch} or from the tag ${input.version}, ` +
        `got ${input.branch || "a detached HEAD"}`,
    )
  if (input.publish && input.worktree)
    return refuse(`Worktree must be clean before publishing:\n${input.worktree}`)

  const published = newestPublished(input.releases)
  if (published && (compareRelease(input.version, published) ?? -1) <= 0)
    return refuse(`Release ${input.version} must be newer than the current fork prerelease ${published}`)

  if (input.existing) {
    if (!input.existing.isDraft)
      return refuse(
        `Published release ${input.version} already exists. Publish ${nextForkVersion(input.version)} instead: ` +
          `installs only move forward by version number, so reusing one leaves every client that already has it behind.`,
      )
    if (!input.existing.isPrerelease)
      return refuse(`Existing draft does not match this release: ${JSON.stringify(input.existing)}`)
    // A tag-driven release is bound to its commit by the tag itself, which the release
    // script proves against the fork, so the commitish field adds nothing there.
    if (!input.tag && input.existing.targetCommitish !== input.head)
      return refuse(`Existing draft does not match this release: ${JSON.stringify(input.existing)}`)
    return { action: "resume" }
  }
  return { action: "create" }
}

/**
 * The newest published prerelease across the whole shared channel. The 1.x line publishes
 * the same tag shape, so it is not filtered out by pattern here; it simply ranks below any
 * 2.x release, which is exactly how the clients order the two lines.
 */
export function newestPublished(releases: ReadonlyArray<KnownRelease>): string | undefined {
  return releases
    .filter((release) => !release.isDraft && release.isPrerelease)
    .flatMap((release) => {
      const version = ForkRelease.version(release.tagName)
      return version === undefined ? [] : [version]
    })
    .sort((left, right) => compareRelease(right, left) ?? 0)[0]
}

export function nextForkVersion(version: string): string {
  const counter = Number(version.slice(version.lastIndexOf(".") + 1))
  const base = releaseBase(version)
  return Number.isSafeInteger(counter)
    ? `${base}-${ForkRelease.channel}.${counter + 1}`
    : `${base}-${ForkRelease.channel}.1`
}

/** The upstream base a patched release is cut from: `2.0.26` for `2.0.26-patched.3`. */
export function releaseBase(version: string) {
  const marker = `-${ForkRelease.channel}.`
  if (!version.includes(marker)) return version
  return version.slice(0, version.indexOf(marker))
}

function refuse(reason: string): ReleasePlan {
  return { action: "refuse", reason }
}
