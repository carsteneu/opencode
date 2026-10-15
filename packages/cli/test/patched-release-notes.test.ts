import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ForkRelease } from "@opencode/util/installation/fork-release"
import { composeReleaseNotes, readNotes, type ReleaseNotesInput } from "../script/patched-release-notes"
import { tmpdir } from "./fixture/tmpdir"

const channel = ForkRelease.channel
const binary = "opencode-linux-x64"
const checksum = "opencode-linux-x64.sha256"

function notes(overrides: Partial<ReleaseNotesInput> = {}) {
  return composeReleaseNotes({
    version: `2.0.29-${channel}.2`,
    baseVersion: "2.0.29",
    previous: `2.0.29-${channel}.1`,
    commits: [],
    assets: [
      { name: binary, size: 95647240 },
      { name: checksum, size: 97 },
    ],
    notes: undefined,
    ...overrides,
  })
}

const commit = (hash: string, subject: string) => ({ hash, subject })

describe("composeReleaseNotes", () => {
  test("composes the whole body", () => {
    expect(
      notes({
        commits: [
          commit("598ee5bc2b", "feat(tui): highlight code fences without an info string"),
          commit("630f740a36", "fix(release): name workingv2 as the publish branch"),
          commit("1b1b0d6212", "docs(ci): use a releasable example version in the patched workflow"),
          commit("deadbeef01", "chore: generate"),
          commit("deadbeef02", "Merge branch 'dev' of github.com:anomalyco/opencode into dev"),
        ],
      }),
    ).toBe(`Fork prerelease of OpenCode **2.0.29-${channel}.2** for Linux x64.

Base: upstream **2.0.29**.

## What is in this build

Our commits since the previous prerelease **2.0.29-${channel}.1**.

### feat
- **tui**: highlight code fences without an info string (\`598ee5bc2b\`)

### fix
- **release**: name workingv2 as the publish branch (\`630f740a36\`)

### docs
- **ci**: use a releasable example version in the patched workflow (\`1b1b0d6212\`)

2 commits left out (merges and version syncs and generated files).

## Assets

| Asset | Size (bytes) |
| --- | --- |
| \`${binary}\` | 95,647,240 |
| \`${checksum}\` | 97 |

The \`.sha256\` sidecar holds the SHA-256 digest and the asset name, so \`sha256sum -c\` verifies the download.

## Updating

Updates come from the fork channel \`${ForkRelease.repository}\`, channel \`${channel}\`. The regular update channel stays \`latest\`.`)
  })

  test("groups the commits by type, in the order the fork lists them", () => {
    const body = notes({
      commits: [
        commit("aaaaaaaaaa", "chore: keep the fork's AGENTS.md out of the repository"),
        commit("bbbbbbbbbb", "refactor(cli): split the release script"),
        commit("cccccccccc", "ci: serialize the whole workflow"),
        commit("dddddddddd", "docs: record the fork release route in AGENTS.md"),
        commit("eeeeeeeeee", "fix(core): keep the retry hint visible"),
        commit("ffffffffff", "feat(cli): accept the release tag as a publish identity"),
      ],
    })
    const groups = ["### feat", "### fix", "### docs", "### ci", "### chore", "### refactor"].map((heading) =>
      body.indexOf(heading),
    )
    expect(groups.every((position) => position !== -1)).toBe(true)
    expect(groups).toEqual([...groups].sort((left, right) => left - right))
  })

  test("keeps commits whose type the fork does not list, under other", () => {
    const body = notes({
      commits: [
        commit("aaaaaaaaaa", "test(core): cover reload during a running reconnect episode"),
        commit("bbbbbbbbbb", "release: v2.0.29"),
        commit("cccccccccc", "a subject without a type"),
      ],
    })
    expect(body).toContain("### other")
    expect(body).toContain("- test(core): cover reload during a running reconnect episode (`aaaaaaaaaa`)")
    expect(body).toContain("- release: v2.0.29 (`bbbbbbbbbb`)")
    expect(body).toContain("- a subject without a type (`cccccccccc`)")
  })

  test("leaves out merge commits", () => {
    const body = notes({
      commits: [
        commit("1111111111", "merge: highlight code fences that carry no info string"),
        commit("2222222222", "Merge remote-tracking branch 'origin/dev' into test/merge-upstream-1.18.34"),
      ],
    })
    expect(body).not.toContain("1111111111")
    expect(body).not.toContain("2222222222")
    expect(body).toContain("2 commits left out (merges).")
  })

  test("leaves out the administrative commits and names their number in one line", () => {
    const body = notes({
      commits: [
        commit("1111111111", "chore: generate"),
        commit("2222222222", "chore: sync version to 2.0.29"),
        commit("3333333333", "chore(release): 2.0.29"),
        commit("4444444444", "ci: bump the release tag"),
        commit("5555555555", "chore: keep the fork's AGENTS.md out of the repository"),
      ],
    })
    for (const hash of ["1111111111", "2222222222", "3333333333", "4444444444"]) expect(body).not.toContain(hash)
    expect(body).toContain("4 commits left out (version syncs and generated files).")
    expect(body).toContain("- keep the fork's AGENTS.md out of the repository (`5555555555`)")
  })

  test("names the upstream jump when the base changes", () => {
    const body = notes({
      version: `2.0.29-${channel}.1`,
      previous: `2.0.26-${channel}.4`,
      commits: [commit("598ee5bc2b", "feat(tui): highlight code fences without an info string")],
    })
    expect(body).toContain(
      "Base change: this release moves from upstream **2.0.26** to **2.0.29**: the build sits on a different upstream base than the previous prerelease. This is a base change, so the text lists only our own commits, not the upstream wave.",
    )
  })

  test("has no base change line while the base stays the same", () => {
    expect(notes()).not.toContain("Base change")
  })

  test("shows the fork's own core points instead of commits without a previous release", () => {
    const body = notes({ previous: undefined, commits: [] })
    expect(body).toContain(
      "The newest published prerelease does not stand behind this commit, so there is no commit list to show against one. What this build carries:",
    )
    expect(body).toContain(`- Checksum-verified self-update channel from \`${ForkRelease.repository}\`, channel \`${channel}\`.`)
    expect(body).toContain("- One Linux x64 binary and its `.sha256` sidecar, verified against the digest before it is installed.")
    expect(body).toContain("- Built from the fork's own line on top of upstream 2.0.29.")
    expect(body).not.toContain("Our commits since")
    expect(body).not.toContain("left out")
  })

  test("says so when no commit of ours landed since the previous release", () => {
    const body = notes()
    expect(body).toContain("Our commits since the previous prerelease **2.0.29-patched.1**.")
    expect(body).toContain("No commits of our own landed since then.")
    expect(body).not.toContain("left out")
  })

  test("keeps a commit subject literal on the published page", () => {
    const body = notes({
      commits: [
        commit("aaaaaaaaaa", "fix: read the token from [here](https://evil.example) before asking @everyone"),
        commit("bbbbbbbbbb", "fix(tui): end the span with a backtick ` here"),
        commit("cccccccccc", "<img src=x onerror=alert(1)>"),
        commit("dddddddddd", "fix: &commat;everyone should not become a mention"),
      ],
    })
    expect(body).toContain(
      "- read the token from \\[here\\](https://evil.example) before asking \\@everyone (`aaaaaaaaaa`)",
    )
    expect(body).toContain("- **tui**: end the span with a backtick \\` here (`bbbbbbbbbb`)")
    expect(body).toContain("- \\<img src=x onerror=alert(1)\\> (`cccccccccc`)")
    expect(body).toContain("- \\&commat;everyone should not become a mention (`dddddddddd`)")
  })

  test("has no Notes section without handwritten notes", () => {
    expect(notes()).not.toContain("## Notes")
  })

  test("inserts handwritten notes under Notes", () => {
    const body = notes({ notes: "The session picker remembers its filter." })
    expect(body).toEndWith("## Notes\n\nThe session picker remembers its filter.")
  })
})

describe("readNotes", () => {
  test("has no notes when the notes file does not exist", async () => {
    await using directory = await tmpdir()
    expect(await readNotes(path.join(directory.path, "RELEASE_NOTES.md"), `2.0.29-${channel}.2`)).toBeUndefined()
  })

  test("refuses to skip a notes file that was named explicitly", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "missing.md")
    expect(readNotes(file, `2.0.29-${channel}.2`, true)).rejects.toThrow(`The notes file ${file} does not exist`)
  })

  test("reads the notes file when it exists", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, "Handwritten note.\n")
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBe("Handwritten note.")
  })

  test("treats an empty notes file as no notes", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, "\n  \n")
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBeUndefined()
  })

  test("takes the section for this version out of a sectioned file", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(
      file,
      `# Fork prereleases\n\n## 2.0.29-${channel}.2\n\nThe session picker remembers its filter.\n\n## 2.0.29-${channel}.1\n\nAn older note.\n`,
    )
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBe("The session picker remembers its filter.")
  })

  test("finds the version behind a heading that says more than the version", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, `## Notes for 2.0.29-${channel}.2\n\nThe session picker remembers its filter.\n`)
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBe("The session picker remembers its filter.")
  })

  test("refuses a sectioned notes file that has no section for this version", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, `## 2.0.29-${channel}.1\n\nAn older note.\n`)
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBeUndefined()
    expect(readNotes(file, `2.0.29-${channel}.2`, true)).rejects.toThrow(
      `The notes file ${file} has no section for 2.0.29-${channel}.2`,
    )
  })

  test("refuses an empty notes file that was named explicitly", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, "\n")
    expect(readNotes(file, `2.0.29-${channel}.2`, true)).rejects.toThrow(`The notes file ${file} is empty`)
  })

  test("has no notes when a sectioned file has no section for this version", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, `## 2.0.29-${channel}.1\n\nAn older note.\n`)
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBeUndefined()
  })

  test("takes the whole file when it carries no version sections", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "RELEASE_NOTES.md")
    await Bun.write(file, "# These builds are unofficial\n\nInstall at your own risk.\n")
    expect(await readNotes(file, `2.0.29-${channel}.2`)).toBe("# These builds are unofficial\n\nInstall at your own risk.")
  })
})
