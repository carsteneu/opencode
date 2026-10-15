export * as ForkRelease from "./fork-release.js"

/**
 * The one place that defines the fork release channel: repository, channel
 * string, tag pattern, asset names and the checksum sidecar. The updater and
 * the release tooling read these values and nothing else re-declares them.
 *
 * The shape mirrors the published 1.x patched prereleases so that an existing
 * 1.x patched install can move to a 2.x prerelease without changing 1.x code.
 *
 *   repository  carsteneu/opencode
 *   channel     patched
 *   tag         v<x.y.z>-patched.<n>          e.g. v2.0.26-patched.1
 *   assets      opencode-linux-x64            raw binary
 *               opencode-linux-x64.sha256     "<hex>  opencode-linux-x64"
 *
 * Sharing the channel and ordering it by version has two consequences that are
 * accepted deliberately, not oversights:
 *
 *   - The 1.x auto-update path takes the newest prerelease in the channel and has
 *     no major-version consent step - only 2.x asks for one - so publishing the
 *     first 2.x prerelease moves every 1.x patched install on the default policy
 *     to 2.x.
 *   - The frozen 1.x release script refuses to publish unless its own version is
 *     newer than the newest published patched prerelease, which it ranks across the
 *     whole channel. While a 2.x prerelease is the newest entry, the 1.x line can
 *     still build and stage a release locally, but it cannot create or publish one.
 *     That line is frozen, so this is the intended end state.
 */

export const repository = "carsteneu/opencode"

export const channel = "patched"

/** Environment variable that points the release source at a fixture channel. */
export const sourceVariable = "OPENCODE_FORK_RELEASE_SOURCE"

// Components reject leading zeros, like the release version parser in the CLI.
const component = "(?:0|[1-9][0-9]*)"
const tagPattern = new RegExp(`^v?(${component}\\.${component}\\.${component}-patched\\.${component})$`)

/** Normalised fork version of a tag or version string, or undefined. */
export function version(input: string) {
  return input.trim().match(tagPattern)?.[1]
}

/** Raw binary asset for a platform, or undefined when the fork does not build it. */
export function asset(platform: string = process.platform, arch: string = process.arch) {
  if (platform !== "linux" || arch !== "x64") return undefined
  return "opencode-linux-x64"
}

/** The SHA-256 sidecar asset that belongs to a binary asset. */
export function checksumAsset(binary: string) {
  return `${binary}.sha256`
}

/** Content of the checksum sidecar. */
export function checksumFile(hash: string, binary: string) {
  return `${hash}  ${binary}\n`
}

/** Digest of a checksum sidecar, or undefined when it is malformed. */
export function checksumDigest(text: string) {
  return text.match(/^\s*([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase()
}

/** Asset URLs are fetched as published, so only https or a loopback fixture passes. */
export function url(input: string) {
  try {
    const parsed = new URL(input)
    if (parsed.username || parsed.password) return
    if (parsed.protocol === "https:") return parsed.toString()
    if (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
      return parsed.toString()
  } catch {}
  return undefined
}

export type Asset = {
  readonly name: string
  readonly browser_download_url: string
}

export type Release = {
  readonly tag_name: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly assets: ReadonlyArray<Asset>
}

const isAsset = (value: unknown): value is Asset =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Asset).name === "string" &&
  typeof (value as Asset).browser_download_url === "string"

const isRelease = (value: unknown): value is Release =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Release).tag_name === "string" &&
  typeof (value as Release).draft === "boolean" &&
  typeof (value as Release).prerelease === "boolean" &&
  Array.isArray((value as Release).assets) &&
  (value as Release).assets.every(isAsset)

/** The published release list; entries that do not match the release shape are dropped. */
export function releases(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter(isRelease)
}

/** REST base of the release source; the fixture channel overrides it. */
export function api() {
  return (process.env[sourceVariable] ?? "https://api.github.com").replace(/\/+$/, "")
}

/** Newest-first listing of the repository's releases. */
export function releasesUrl() {
  return `${api()}/repos/${repository}/releases?per_page=30`
}

/**
 * The fork prereleases that ship a complete, fetchable asset pair for this
 * platform. Drafts and published releases stay invisible: the pipeline
 * publishes prereleases only. Ranking belongs to the caller.
 */
export function candidates(list: ReadonlyArray<Release>) {
  const binary = asset()
  if (!binary) return []
  const checksum = checksumAsset(binary)
  const usable = (release: Release) => release.assets.every((item) => url(item.browser_download_url) !== undefined)
  return list
    .filter((release) => version(release.tag_name) !== undefined)
    .filter((release) => !release.draft && release.prerelease)
    .filter((release) => release.assets.some((item) => item.name === binary))
    .filter((release) => release.assets.some((item) => item.name === checksum))
    .filter(usable)
}
