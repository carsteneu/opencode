import { describe, expect, test } from "bun:test"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import { nextForkVersion, planForkRelease, type KnownRelease } from "../script/patched-release-plan"

const head = "5f6f7cfe18adfdf806629b72dc69d303639f0a72"
const channel = ForkRelease.channel

function plan(overrides: Partial<Parameters<typeof planForkRelease>[0]> = {}) {
  return planForkRelease({
    version: `2.0.26-${channel}.4`,
    publish: true,
    releaseBranch: "v2-release-align",
    branch: "v2-release-align",
    tag: undefined,
    worktree: "",
    packageVersion: "2.0.26",
    releases: [],
    existing: undefined,
    head,
    ...overrides,
  })
}

function refusal(overrides: Partial<Parameters<typeof planForkRelease>[0]> = {}) {
  const result = plan(overrides)
  if (result.action !== "refuse") throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result.reason
}

const release = (tagName: string, extra: Partial<KnownRelease> = {}): KnownRelease => ({
  tagName,
  isDraft: false,
  isPrerelease: true,
  ...extra,
})

describe("planForkRelease", () => {
  test("publishes a new prerelease", () => {
    expect(plan()).toEqual({ action: "create" })
  })

  test("resumes a draft that belongs to this commit", () => {
    expect(plan({ existing: { isDraft: true, isPrerelease: true, targetCommitish: head } })).toEqual({
      action: "resume",
    })
  })

  test("refuses a version that is not a patched release", () => {
    expect(plan({ version: "2.0.26" })).toEqual({
      action: "refuse",
      reason: `2.0.26 is not an x.y.z-${channel}.n release`,
    })
    // The retired marker: the four 2.0.26-v2patched.* prereleases were unreachable
    // from every client, so the old shape must not become publishable again.
    expect(plan({ version: `2.0.26-v2${channel}.4` }).action).toBe("refuse")
    expect(plan({ version: `2.0.26-${channel}.04` }).action).toBe("refuse")
  })

  test("refuses a base that does not match the package version", () => {
    expect(plan({ version: `2.0.25-${channel}.4` })).toEqual({
      action: "refuse",
      reason: "Release base 2.0.25 does not match packages/cli version 2.0.26",
    })
  })

  test("refuses to publish from another branch or a dirty worktree", () => {
    expect(refusal({ branch: "working" })).toContain("must be published from v2-release-align")
    expect(refusal({ worktree: " M packages/cli/src/index.ts" })).toContain("Worktree must be clean")
  })

  test("publishes from the tag it names, where the branch is a detached HEAD", () => {
    // The tag-push route: GitHub reads the workflow from the tagged commit and checks that
    // commit out, so there is no branch to compare - the tag naming this exact version is
    // the release identity instead.
    expect(plan({ tag: `2.0.26-${channel}.4`, branch: "" })).toEqual({ action: "create" })
  })

  test("refuses to publish one version from another version's tag", () => {
    expect(refusal({ tag: `2.0.26-${channel}.3`, branch: "" })).toContain(
      `must be published from v2-release-align or from the tag 2.0.26-${channel}.4`,
    )
    // A dispatch from a feature branch has no tag either, so it stays refused.
    expect(refusal({ branch: "feature" })).toContain("must be published from v2-release-align")
  })

  test("resumes a tag-driven draft without comparing target_commitish", () => {
    // GitHub documents target_commitish as unused when the tag already exists, so for a
    // tag-driven release it can name the default branch rather than the tagged commit. The
    // commit binding comes from the tag itself in that mode, not from this field.
    expect(
      plan({
        tag: `2.0.26-${channel}.4`,
        branch: "",
        existing: { isDraft: true, isPrerelease: true, targetCommitish: "dev" },
      }),
    ).toEqual({ action: "resume" })
    // ...and the branch route keeps refusing a draft that belongs to another commit.
    expect(plan({ existing: { isDraft: true, isPrerelease: true, targetCommitish: "dev" } }).action).toBe("refuse")
  })

  test("publishes from the configured branch when it is overridden", () => {
    expect(plan({ releaseBranch: "v2", branch: "v2" })).toEqual({ action: "create" })
  })

  test("a build-only run does not require a clean worktree or the release branch", () => {
    expect(plan({ publish: false, branch: "feature", worktree: " M x" })).toEqual({ action: "create" })
  })

  test("refuses a version that is not newer than the newest patched prerelease", () => {
    expect(
      plan({ releases: [release(`2.0.26-${channel}.4`), release(`2.0.26-${channel}.3`)] }),
    ).toEqual({
      action: "refuse",
      reason: `Release 2.0.26-${channel}.4 must be newer than the current fork prerelease 2.0.26-${channel}.4`,
    })
    expect(plan({ releases: [release(`2.0.26-${channel}.5`)] }).action).toBe("refuse")
  })

  test("orders against the whole shared channel, where the 1.x line is lower", () => {
    // The two lines share one tag shape, so a 1.x release is not filtered away by
    // pattern any more; it only ever ranks below a 2.x release.
    expect(plan({ releases: [release("1.18.34-patched.220")] })).toEqual({ action: "create" })
    // A published 2.x release still blocks a republish, with 1.x releases next to it.
    expect(
      plan({
        version: `2.0.26-${channel}.1`,
        releases: [release("1.18.34-patched.220"), release(`2.0.26-${channel}.1`)],
      }).action,
    ).toBe("refuse")
  })

  test("ignores drafts, published releases and the retired marker", () => {
    expect(
      plan({
        releases: [
          release(`2.0.26-${channel}.9`, { isDraft: true }),
          release("2.0.27", { isPrerelease: false }),
          release(`2.0.26-v2${channel}.4`),
        ],
      }),
    ).toEqual({ action: "create" })
  })

  test("refuses an already published version and names the next number", () => {
    const reason = refusal({ existing: { isDraft: false, isPrerelease: true, targetCommitish: head } })
    expect(reason).toContain(`Publish 2.0.26-${channel}.5 instead`)
    expect(reason).toContain("only move forward by version number")
  })

  test("refuses a draft built from another commit or without the prerelease flag", () => {
    expect(
      plan({ existing: { isDraft: true, isPrerelease: true, targetCommitish: "0000000000000000000000000000000000000000" } }).action,
    ).toBe("refuse")
    expect(plan({ existing: { isDraft: true, isPrerelease: false, targetCommitish: head } }).action).toBe("refuse")
  })
})

describe("nextForkVersion", () => {
  test("advances the counter", () => {
    expect(nextForkVersion(`2.0.26-${channel}.1`)).toBe(`2.0.26-${channel}.2`)
    expect(nextForkVersion(`2.0.26-${channel}.19`)).toBe(`2.0.26-${channel}.20`)
  })

  test("falls back to the first counter for an unparsable version", () => {
    expect(nextForkVersion(`2.0.26-${channel}.99999999999999999999`)).toBe(`2.0.26-${channel}.1`)
  })
})
