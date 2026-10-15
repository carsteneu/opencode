import { releaseBase } from "./patched-release-plan"
import type { ReleaseCommit } from "./patched-release-notes"

/** Runs a git command in the release checkout and returns its stdout. Injected so the selection
 * can be exercised against a throwaway repository. */
export type Git = (command: ReadonlyArray<string>) => Promise<string>

/**
 * Our own commits since the previous published prerelease.
 *
 * The range is everything since that release minus the upstream wave a base change brought in.
 * Upstream's release commit for our base (`release: v2.0.29`) sits in the fork's own history
 * once the base has been merged, so excluding its ancestry is enough; while the base stays the
 * same that wave is older than `previous` and the exclusion changes nothing.
 *
 * The two ways that exclusion can fail are loud rather than silent: the range cannot be read,
 * or a base change has no upstream release commit to exclude. A release body that lists the
 * upstream wave while stating that it lists only our commits would be worse than no body.
 */
export async function releaseCommits(
  git: Git,
  input: { readonly previous: string | undefined; readonly base: string; readonly head: string },
): Promise<ReadonlyArray<ReleaseCommit>> {
  if (input.previous === undefined) return []

  const pattern = `^release: v${input.base.replaceAll(".", "\\.")}$`
  const upstream = (await git(["rev-list", "--max-count=1", "--grep", pattern, input.head])).trim()
  if (upstream === "" && releaseBase(input.previous) !== input.base)
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
      ...(upstream === "" ? [] : ["--not", upstream]),
    ])
  } catch (cause) {
    throw new Error(`Cannot read the commits since ${input.previous}: is that tag in this clone?`, { cause })
  }

  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, ...subject] = line.split("\t")
      return { hash: hash!, subject: subject.join("\t") }
    })
}
