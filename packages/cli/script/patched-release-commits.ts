import { releaseBase } from "./patched-release-plan"
import type { ReleaseCommit } from "./patched-release-notes"

/** Runs a git command in the release checkout and returns its stdout. Injected so the selection
 * can be exercised against a throwaway repository. */
export type Git = (command: ReadonlyArray<string>) => Promise<string>

export type ReleaseSelection = {
  /** The previous prerelease the commit list is read against, or undefined when there is none. */
  readonly previous: string | undefined
  readonly commits: ReadonlyArray<ReleaseCommit>
}

/**
 * Which commits a release body lists: ours since the previous prerelease of this line, or none at
 * all when there is no such release to list against.
 *
 * The channel carries more than one line — the frozen 1.x prereleases and the 2.x ones share it,
 * and a release is ranked across the whole channel — so the previous published prerelease can
 * belong to the other line. Such a release shares no commit range with this one: there is nothing
 * to list, and the body says this is the first prerelease of the line instead of presenting the
 * other line's commits as ours. Ancestry decides that, not the version number.
 *
 * The rest is everything since that release minus the upstream wave a base change brought in.
 * Upstream's commit for our base sits in the fork's own history once the base has been merged —
 * `release: v2.0.29` from its tagged line, `sync release versions for v2.0.26 [skip ci]` from its
 * dev line — so excluding that commit's ancestry is enough. While the base stays the same, the
 * wave is older than `previous` and the exclusion changes nothing.
 *
 * A base change whose upstream commit cannot be found fails loudly instead of composing a body
 * that lists the upstream wave while claiming to list only our commits. What still degrades
 * silently is an upstream merge inside an unchanged base: nothing marks such a wave, so it is
 * listed as ours. In this repository upstream has so far only been merged as a base change.
 */
export async function releaseCommits(
  git: Git,
  input: { readonly previous: string | undefined; readonly base: string; readonly head: string },
): Promise<ReleaseSelection> {
  if (input.previous === undefined) return { previous: undefined, commits: [] }
  if (!(await onThisLine(git, input.previous, input.head))) return { previous: undefined, commits: [] }

  const upstream = await upstreamRelease(git, input)
  if (upstream === undefined && releaseBase(input.previous) !== input.base)
    throw new Error(
      `Cannot find upstream's release commit for ${input.base} in this history, so the commits since ` +
        `${input.previous} cannot be told apart from the upstream wave`,
    )

  let log: string
  try {
    log = await git([
      "log",
      "--no-merges",
      "--pretty=format:%h%x09%s",
      `${input.previous}..${input.head}`,
      ...(upstream === undefined ? [] : ["--not", upstream]),
    ])
  } catch (cause) {
    throw new Error(`Cannot read the commits since ${input.previous}: is that tag in this clone?`, { cause })
  }

  return { previous: input.previous, commits: parse(log) }
}

/** The commit upstream released `base` with, from either of the two lines it publishes on. */
async function upstreamRelease(git: Git, input: { readonly base: string; readonly head: string }) {
  const base = input.base.replaceAll(".", "\\.")
  const markers = [`^release: v${base}$`, `^sync release versions for v${base}`]
  // git matches every line of a commit message, and a body line would move the boundary this
  // exclusion rests on. Upstream names these commits in the subject, and only a subject counts.
  const candidates = await git([
    "log",
    "--max-count=50",
    "--pretty=format:%H%x09%s",
    ...markers.flatMap((marker) => ["--grep", marker]),
    input.head,
  ])
  for (const line of candidates.split("\n")) {
    const [hash, ...subject] = line.split("\t")
    if (hash === undefined) continue
    if (markers.some((marker) => new RegExp(marker).test(subject.join("\t")))) return hash
  }
  return undefined
}

/** Whether a release is an ancestor of the head, which is what puts it on the same line. */
async function onThisLine(git: Git, previous: string, head: string) {
  let counts: string
  try {
    counts = await git(["rev-list", "--left-right", "--count", `${previous}...${head}`])
  } catch (cause) {
    throw new Error(`Cannot read ${previous}: is that tag in this clone?`, { cause })
  }
  // No commit of that release is missing from the head: it stands behind the head, so it is on
  // this line. Two lines with nothing in common report commits on both sides instead of failing.
  return counts.trim().split(/\s+/)[0] === "0"
}

function parse(log: string): ReadonlyArray<ReleaseCommit> {
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, ...subject] = line.split("\t")
      return { hash: hash!, subject: subject.join("\t") }
    })
}
