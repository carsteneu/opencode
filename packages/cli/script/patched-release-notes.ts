import { ForkRelease } from "@opencode/util/installation/fork-release"
import { releaseBase } from "./patched-release-plan"

/**
 * The body of a fork prerelease, composed from data the caller has already read. The
 * composition touches no git, no gh, no network and no filesystem, so the text can be
 * asserted on directly; `readNotes` at the bottom is the only function here that reads a
 * file, and the absence of that file is a normal case.
 */

export type ReleaseCommit = {
  readonly hash: string
  readonly subject: string
}

export type ReleaseAsset = {
  readonly name: string
  readonly size: number
}

export type ReleaseNotesInput = {
  readonly version: string
  /** The upstream version the release is cut from, `2.0.29` for `2.0.29-patched.2`. */
  readonly baseVersion: string
  /** The previous published fork prerelease, or undefined for the first one of a line. */
  readonly previous: string | undefined
  /** Our commits since `previous`, as subject lines with their short hash. */
  readonly commits: ReadonlyArray<ReleaseCommit>
  readonly assets: ReadonlyArray<ReleaseAsset>
  /** Handwritten notes, or undefined; without them the body has no Notes section. */
  readonly notes: string | undefined
}

/** The types the commits are listed under, in this order. Everything else lands in `other`. */
const groups = ["feat", "fix", "docs", "ci", "chore", "refactor"]

/** Types a commit of ours may carry and still be pure housekeeping. */
const housekeeping = ["chore", "ci", "build"]

/**
 * Descriptions of a housekeeping commit that carry no change of their own: regenerated
 * files, version syncs and dependency bumps. They are counted in one line instead of being
 * listed, because a release body is read for what changed.
 */
const bookkeeping = ["generate", "regenerate", "sync", "bump", "version", "release", "deps", "dependencies", "lockfile"]

const sizes = new Intl.NumberFormat("en-US")

/** `type(scope): description`, `type: description` and the `!` breaking marker. */
const conventional = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/

type Parsed = { readonly type: string; readonly scope: string | undefined; readonly description: string }

function parse(subject: string): Parsed | undefined {
  const match = subject.match(conventional)
  if (!match) return undefined
  return { type: match[1]!, scope: match[2], description: match[3]!.trim() }
}

/** Both the fork's own `merge: …` subjects and git's `Merge branch …`. */
const isMerge = (subject: string) => /^merge\b/i.test(subject)

function isBookkeeping(commit: ReleaseCommit) {
  const parsed = parse(commit.subject)
  if (!parsed || !housekeeping.includes(parsed.type)) return false
  const description = parsed.description.toLowerCase()
  const scope = parsed.scope?.toLowerCase()
  return bookkeeping.some((word) => description.startsWith(word) || scope === word) || /^\d+\.\d+\.\d+/.test(description)
}

const groupOf = (commit: ReleaseCommit) => {
  const parsed = parse(commit.subject)
  return parsed && groups.includes(parsed.type) ? parsed.type : "other"
}

/**
 * A commit subject is repository text that ends up on a published page, so it stays literal: no
 * Markdown structure — link, image, emphasis, raw HTML — may be built out of it, and it must not
 * close the code span that carries the hash. Escaping `&` also breaks entities, so `&commat;`
 * cannot stand in for a character that was escaped. What this cannot stop is the renderer's own
 * pass over the finished text: a bare URL still becomes a link, and `@name` still becomes a
 * mention however it is escaped.
 */
const literal = (text: string) => text.replace(/[\\`*_[\]<>@|#&]/g, (character) => `\\${character}`)

function entry(group: string, commit: ReleaseCommit) {
  const parsed = parse(commit.subject)
  if (group === "other" || !parsed) return `- ${literal(commit.subject)} (\`${commit.hash}\`)`
  return parsed.scope === undefined
    ? `- ${literal(parsed.description)} (\`${commit.hash}\`)`
    : `- **${literal(parsed.scope)}**: ${literal(parsed.description)} (\`${commit.hash}\`)`
}

export function composeReleaseNotes(input: ReleaseNotesInput): string {
  const lines = [
    `Fork prerelease of OpenCode **${input.version}** for Linux x64.`,
    "",
    `Base: upstream **${input.baseVersion}**.`,
  ]

  const previousBase = input.previous === undefined ? undefined : releaseBase(input.previous)
  if (previousBase !== undefined && previousBase !== input.baseVersion)
    lines.push(
      "",
      `Base change: this release moves from upstream **${previousBase}** to **${input.baseVersion}**: the build sits on a different upstream base than the previous prerelease. This is a base change, so the text lists only our own commits, not the upstream wave.`,
    )

  lines.push("", "## What is in this build", "")

  if (input.previous === undefined) {
    lines.push(
      `The newest published prerelease does not stand behind this commit, so there is no commit list to show against one. What this build carries:`,
      "",
      `- Checksum-verified self-update channel from \`${ForkRelease.repository}\`, channel \`${ForkRelease.channel}\`.`,
      "- One Linux x64 binary and its `.sha256` sidecar, verified against the digest before it is installed.",
      `- Built from the fork's own line on top of upstream ${input.baseVersion}.`,
    )
    return finish(lines, input)
  }

  lines.push(`Our commits since the previous prerelease **${input.previous}**.`)

  const merges = input.commits.filter((commit) => isMerge(commit.subject))
  const omitted = input.commits.filter((commit) => !isMerge(commit.subject) && isBookkeeping(commit))
  const listed = input.commits.filter((commit) => !isMerge(commit.subject) && !isBookkeeping(commit))

  for (const group of [...groups, "other"]) {
    const members = listed.filter((commit) => groupOf(commit) === group)
    if (members.length === 0) continue
    lines.push("", `### ${group}`, ...members.map((commit) => entry(group, commit)))
  }

  // One line for what the list leaves out, so the reader knows the body is complete and not sampled.
  const categories = [
    merges.length > 0 ? "merges" : undefined,
    omitted.length > 0 ? "version syncs and generated files" : undefined,
  ].filter((category) => category !== undefined)
  if (categories.length > 0) {
    const count = merges.length + omitted.length
    lines.push("", `${count} commit${count === 1 ? "" : "s"} left out (${categories.join(" and ")}).`)
  } else if (listed.length === 0) {
    lines.push("", "No commits of our own landed since then.")
  }

  return finish(lines, input)
}

function finish(lines: string[], input: ReleaseNotesInput) {
  lines.push(
    "",
    "## Assets",
    "",
    "| Asset | Size (bytes) |",
    "| --- | --- |",
    ...input.assets.map((asset) => `| \`${asset.name}\` | ${sizes.format(asset.size)} |`),
    "",
    "The `.sha256` sidecar holds the SHA-256 digest and the asset name, so `sha256sum -c` verifies the download.",
    "",
    "## Updating",
    "",
    `Updates come from the fork channel \`${ForkRelease.repository}\`, channel \`${ForkRelease.channel}\`. The regular update channel stays \`latest\`.`,
  )
  if (input.notes !== undefined) lines.push("", "## Notes", "", input.notes)
  return lines.join("\n")
}

/**
 * Content of the handwritten notes for a release, or undefined when there are none — the normal
 * case, not an error. A file may carry one section per prerelease; the section for this version
 * wins, and a file that is sectioned for other releases has no notes for this one. A file without
 * version sections is used whole. `required` is for a path the caller named itself, where a
 * missing file is a mistake rather than the normal case.
 */
export async function readNotes(file: string, version: string, required = false): Promise<string | undefined> {
  if (!(await Bun.file(file).exists())) {
    if (required) throw new Error(`The notes file ${file} does not exist`)
    return undefined
  }
  const text = (await Bun.file(file).text()).trim()
  if (text === "") {
    if (required) throw new Error(`The notes file ${file} is empty`)
    return undefined
  }
  const section = sectioned(text, version)
  if (section === undefined) return text
  if (section === "") {
    // Sectioned for other prereleases and not for this one: naming such a file explicitly is a
    // mistake, not a release that has no notes.
    if (required) throw new Error(`The notes file ${file} has no section for ${version}`)
    return undefined
  }
  return section
}

/** The fork version a heading names, wherever in the heading it appears, or undefined. */
function headingVersion(heading: string) {
  return heading
    .split(/[\s:—–]+/)
    .map((token) => ForkRelease.version(token))
    .find((version) => version !== undefined)
}

/**
 * The section for `version`, "" when the file is sectioned but not for this version, or undefined
 * when the file carries no version sections at all.
 */
function sectioned(text: string, version: string) {
  const lines = text.split("\n")
  const headings = lines.flatMap((line, index) => {
    const heading = line.match(/^#{1,6}\s+(.*\S)\s*$/)?.[1]
    if (heading === undefined) return []
    return [{ index, version: headingVersion(heading) }]
  })
  const releases = headings.filter((heading) => heading.version !== undefined)
  if (releases.length === 0) return undefined
  const ours = releases.find((heading) => heading.version === version)
  if (!ours) return ""
  const next = releases.find((heading) => heading.index > ours.index)
  return lines
    .slice(ours.index + 1, next?.index ?? lines.length)
    .join("\n")
    .trim()
}
