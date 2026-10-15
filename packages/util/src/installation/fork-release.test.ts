import { describe, expect, test } from "bun:test"
import { ForkRelease } from "./fork-release.js"

const complete = {
  tag_name: "v2.0.26-patched.1",
  draft: false,
  prerelease: true,
  assets: [
    { name: "opencode-linux-x64", browser_download_url: "https://example.test/binary" },
    { name: "opencode-linux-x64.sha256", browser_download_url: "https://example.test/binary.sha256" },
  ],
}

describe("fork release contract", () => {
  test("pins the assumed release schema", () => {
    // The sibling release pipeline owns the final schema. These literals are the
    // contract this line was built against (and the shape the 1.x updater reads
    // without changes): if that pipeline lands differently, this test is the
    // place that has to be changed deliberately.
    expect(ForkRelease.repository).toBe("carsteneu/opencode")
    expect(ForkRelease.channel).toBe("patched")
    expect(ForkRelease.asset("linux", "x64")).toBe("opencode-linux-x64")
    expect(ForkRelease.version("2.0.26-patched.1")).toBe("2.0.26-patched.1")
    expect(ForkRelease.url("https://github.com/release/asset")).toBeString()
  })

  test("recognises fork versions and rejects everything else", () => {
    expect(ForkRelease.version("v2.0.26-patched.1")).toBe("2.0.26-patched.1")
    expect(ForkRelease.version(" 2.0.26-patched.10\n")).toBe("2.0.26-patched.10")
    expect(ForkRelease.version("2.0.26")).toBeUndefined()
    expect(ForkRelease.version("2.0.26-beta.1")).toBeUndefined()
    expect(ForkRelease.version("2.0.26-patched")).toBeUndefined()
    expect(ForkRelease.version("2.0.26-patched.x")).toBeUndefined()
    // The CLI release parser rejects leading zeros, so the tag pattern must too.
    expect(ForkRelease.version("2.0.026-patched.1")).toBeUndefined()
    expect(ForkRelease.version("2.0.26-patched.01")).toBeUndefined()
  })

  test("names the asset pair for the published platform", () => {
    expect(ForkRelease.asset("linux", "x64")).toBe("opencode-linux-x64")
    expect(ForkRelease.asset("darwin", "arm64")).toBeUndefined()
    expect(ForkRelease.checksumAsset("opencode-linux-x64")).toBe("opencode-linux-x64.sha256")
  })

  test("owns the checksum sidecar format", () => {
    const hash = "a".repeat(64)
    expect(ForkRelease.checksumFile(hash, "opencode-linux-x64")).toBe(`${hash}  opencode-linux-x64\n`)
    expect(ForkRelease.checksumDigest(`${hash}  opencode-linux-x64\n`)).toBe(hash)
    expect(ForkRelease.checksumDigest(`${hash.toUpperCase()} opencode-linux-x64`)).toBe(hash)
    expect(ForkRelease.checksumDigest("not a checksum")).toBeUndefined()
  })

  test("accepts only fetchable asset URLs", () => {
    expect(ForkRelease.url("https://github.com/release/asset")).toBe("https://github.com/release/asset")
    expect(ForkRelease.url("http://127.0.0.1:41234/asset")).toBe("http://127.0.0.1:41234/asset")
    expect(ForkRelease.url("http://localhost/asset")).toBe("http://localhost/asset")
    expect(ForkRelease.url("http://evil.test/asset")).toBeUndefined()
    expect(ForkRelease.url("https://user:secret@evil.test/asset")).toBeUndefined()
    expect(ForkRelease.url("file:///etc/passwd")).toBeUndefined()
    expect(ForkRelease.url("not a url")).toBeUndefined()
  })

  test("drops release entries that do not match the published shape", () => {
    expect(ForkRelease.releases("nonsense")).toEqual([])
    expect(ForkRelease.releases([complete, null, { tag_name: "2.0.26" }, { ...complete, assets: "nope" }])).toEqual([
      complete,
    ])
  })

  test("keeps drafts, published releases and incomplete entries out of the candidates", () => {
    if (!ForkRelease.asset("linux", "x64")) return
    const draft = { ...complete, draft: true }
    const published = { ...complete, tag_name: "v2.0.27-patched.1", prerelease: false }
    const partial = {
      ...complete,
      tag_name: "v2.0.28-patched.1",
      assets: [{ name: "opencode-linux-x64", browser_download_url: "https://example.test/binary" }],
    }
    const unreachable = {
      ...complete,
      tag_name: "v2.0.29-patched.1",
      assets: complete.assets.map((asset) => ({ ...asset, browser_download_url: "http://evil.test/asset" })),
    }
    expect(ForkRelease.candidates([complete, draft, published, partial, unreachable])).toEqual([complete])
  })

  test("points the release source at the fixture channel", () => {
    const variable = ForkRelease.sourceVariable
    const previous = process.env[variable]
    try {
      delete process.env[variable]
      expect(ForkRelease.releasesUrl()).toBe(
        `https://api.github.com/repos/${ForkRelease.repository}/releases?per_page=30`,
      )
      process.env[variable] = "http://127.0.0.1:41234/"
      expect(ForkRelease.releasesUrl()).toBe(
        `http://127.0.0.1:41234/repos/${ForkRelease.repository}/releases?per_page=30`,
      )
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })
})
