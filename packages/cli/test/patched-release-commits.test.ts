import { describe, expect, test } from "bun:test"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import { releaseCommits, type Git } from "../script/patched-release-commits"
import { tmpdir } from "./fixture/tmpdir"

const channel = ForkRelease.channel

/**
 * The selection under test decides what the release body claims to list, so it runs against a
 * throwaway repository that mirrors the fork's shape: upstream's release commits, the fork's own
 * line, and the merge that brings a new base in.
 */
async function repository(directory: string) {
  const git: Git = async (command) => {
    const child = Bun.spawn(["git", ...command], { cwd: directory, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(stderr.trim() || `git ${command.join(" ")} failed`)
    return stdout
  }
  await git(["init", "--quiet"])
  await git(["config", "user.email", "release@example.test"])
  await git(["config", "user.name", "release"])
  const commit = async (message: string) => {
    await git(["commit", "--quiet", "--allow-empty", "-m", message])
    return (await git(["rev-parse", "HEAD"])).trim()
  }
  return { git, commit }
}

describe("releaseCommits", () => {
  test("lists our own commits since the previous prerelease, without the upstream wave", async () => {
    await using directory = await tmpdir()
    const { git, commit } = await repository(directory.path)
    const base = await commit("release: v2.0.26")
    await commit("feat(cli): our commit before the previous release")
    await git(["tag", `2.0.26-${channel}.4`])
    await commit("fix(cli): our commit after the previous release")
    // Upstream moves on from the same base, and the fork merges the new release in.
    await git(["checkout", "--quiet", "-b", "upstream", base])
    await commit("fix(core): an upstream fix (#55267)")
    await commit("feat(app): an upstream feature (#55306)")
    await commit("release: v2.0.29")
    await git(["checkout", "--quiet", "-"])
    await git(["merge", "--quiet", "--no-ff", "upstream", "-m", "merge: upstream v2.0.29 into the fork v2 line"])
    await commit("docs: our commit after the base change")

    expect(await releaseCommits(git, { previous: `2.0.26-${channel}.4`, base: "2.0.29", head: "HEAD" })).toEqual([
      { hash: expect.any(String), subject: "docs: our commit after the base change" },
      { hash: expect.any(String), subject: "fix(cli): our commit after the previous release" },
    ])
  })

  test("excludes nothing while the base stays the same", async () => {
    await using directory = await tmpdir()
    const { git, commit } = await repository(directory.path)
    await commit("release: v2.0.29")
    await commit("feat(cli): an older commit")
    await git(["tag", `2.0.29-${channel}.1`])
    await commit("fix(cli): a commit since the previous prerelease")

    expect(await releaseCommits(git, { previous: `2.0.29-${channel}.1`, base: "2.0.29", head: "HEAD" })).toEqual([
      { hash: expect.any(String), subject: "fix(cli): a commit since the previous prerelease" },
    ])
  })

  test("has nothing to list without a previous prerelease", async () => {
    await using directory = await tmpdir()
    const { git, commit } = await repository(directory.path)
    await commit("feat(cli): the first commit of the line")

    expect(await releaseCommits(git, { previous: undefined, base: "2.0.29", head: "HEAD" })).toEqual([])
  })

  test("refuses a base change whose upstream release commit is not in this history", async () => {
    await using directory = await tmpdir()
    const { git, commit } = await repository(directory.path)
    await commit("feat(cli): an older commit")
    await git(["tag", `2.0.26-${channel}.4`])
    await commit("fix(core): something that arrived without a release commit")

    // Without the exclusion the range lists every upstream commit as one of ours while the body
    // states that it lists only ours, so this has to fail instead of composing.
    expect(releaseCommits(git, { previous: `2.0.26-${channel}.4`, base: "2.0.29", head: "HEAD" })).rejects.toThrow(
      "Cannot find upstream's release commit for 2.0.29",
    )
  })

  test("names the tag when this clone does not carry it", async () => {
    await using directory = await tmpdir()
    const { git, commit } = await repository(directory.path)
    await commit("release: v2.0.29")
    await commit("feat(cli): a commit")

    expect(releaseCommits(git, { previous: `2.0.29-${channel}.9`, base: "2.0.29", head: "HEAD" })).rejects.toThrow(
      `Cannot read the commits since 2.0.29-${channel}.9`,
    )
  })
})
