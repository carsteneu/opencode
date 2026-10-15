import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, link, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import {
  binaryAsset,
  executable,
  serve,
  supported,
  type Fault,
  type Fixture,
  type Release,
} from "./fixture/fork-channel"

const entry = path.join(import.meta.dir, "..", "src", "index.ts")
const runtime = Bun.which("bun") ?? process.execPath
const roots: string[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
  fixtures.splice(0).forEach((fixture) => fixture.close())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const digest = async (file: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")

/** Staged downloads must not survive a failed upgrade. */
const leftovers = async (binary: string) =>
  (await readdir(path.dirname(binary))).filter((name) => name.includes(".update-"))

/**
 * Runs `opencode upgrade` from an isolated install. The updater replaces the
 * file it runs from, so the CLI is executed through an executable that sits at
 * the install path — the same layout the install script creates.
 */
async function upgrade(input: {
  readonly version: string
  readonly source: string
  readonly args?: ReadonlyArray<string>
  readonly installed?: boolean
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-fork-"))
  roots.push(root)
  const binary = path.join(root, ".opencode", "bin", "opencode")
  if (input.installed !== false) {
    await mkdir(path.dirname(binary), { recursive: true })
    await link(runtime, binary).catch(() => copyFile(runtime, binary))
  }
  const child = Bun.spawn(
    [
      input.installed === false ? runtime : binary,
      "--define",
      `OPENCODE_VERSION="${input.version}"`,
      "--define",
      'OPENCODE_CHANNEL="latest"',
      "--define",
      'OPENCODE_UPDATE_CHANNEL="patched"',
      entry,
      "upgrade",
      ...(input.args ?? []),
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_FORK_RELEASE_SOURCE: input.source,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    root,
    binary,
    code,
    output: stripVTControlCharacters(`${stdout}\n${stderr}`),
    installed: await Bun.file(binary).exists(),
  }
}

const start = (releases: ReadonlyArray<Release>, faults: ReadonlyArray<Fault> = []) =>
  serve(releases, faults).then((fixture) => {
    fixtures.push(fixture)
    return fixture
  })

const patched = "2.0.26-patched.1"

describe.skipIf(!supported)("fork update channel", () => {
  test("installs the newest patched release over the installed binary", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url })
    expect(result.code).toBe(0)
    expect(result.output).toContain("Upgrade complete")
    const installed = await digest(result.binary)
    const expected = new Bun.CryptoHasher("sha256").update(executable(patched)).digest("hex")
    expect(installed).toBe(expected)
    expect(fixture.requests).toEqual([
      "/repos/carsteneu/opencode/releases",
      `/assets/${patched}/${binaryAsset}.sha256`,
      `/assets/${patched}/${binaryAsset}`,
    ])
    const version = Bun.spawnSync([result.binary])
    expect(version.stdout.toString().trim()).toBe(`opencode v${patched}`)
  })

  test("picks the newest release and ignores drafts, published and incomplete ones", async () => {
    const fixture = await start([
      { tag: "v2.0.26-patched.0" },
      { tag: `v${patched}`, draft: true },
      { tag: "v2.0.27-patched.1", omitChecksum: true },
      // A full release with a valid patched tag: the pipeline publishes
      // prereleases, so a published one stays invisible.
      { tag: "v2.0.28-patched.1", prerelease: false },
      { tag: "v2.0.26-beta.1", prerelease: true },
    ])
    const result = await upgrade({ version: "2.0.25-patched.9", source: fixture.url })
    expect(result.code).toBe(0)
    const expected = new Bun.CryptoHasher("sha256").update(executable("2.0.26-patched.0")).digest("hex")
    expect(await digest(result.binary)).toBe(expected)
  })

  test("refuses a checksum that does not describe the download", async () => {
    const body = executable(patched)
    const fixture = await start([{ tag: `v${patched}`, checksum: `${"0".repeat(64)}  ${binaryAsset}\n` }])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("checksum")
    expect(await digest(result.binary)).toBe(before)
    expect(await digest(result.binary)).not.toBe(new Bun.CryptoHasher("sha256").update(body).digest("hex"))
    expect(await leftovers(result.binary)).toEqual([])
  })

  test("leaves the install untouched when the download aborts", async () => {
    const fixture = await start([{ tag: `v${patched}` }], ["truncate-binary"])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("Could not download")
    expect(await digest(result.binary)).toBe(before)
    expect(await leftovers(result.binary)).toEqual([])
  })

  test("refuses an asset that does not report the target version", async () => {
    const fixture = await start([{ tag: `v${patched}`, binary: executable("2.0.26-patched.0") }])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("failed verification")
    expect(await digest(result.binary)).toBe(before)
  })

  test("treats an already installed release as a no-op", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: patched, source: fixture.url })
    expect(result.code).toBe(0)
    expect(result.output).toContain("already installed")
    expect(fixture.requests).toEqual([`/repos/carsteneu/opencode/releases`])
  })

  test("refuses the official release target", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url, args: ["2.0.26"] })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("not a release of carsteneu/opencode")
    expect(await digest(result.binary)).toBe(before)
  })

  test("refuses an automatic major change and names the transfer command", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: "1.18.34", source: fixture.url })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("major OpenCode upgrade")
    expect(result.output).toContain("opencode upgrade --major")
    expect(await digest(result.binary)).toBe(before)
  })

  test("transfers to the new line with --major", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: "1.18.34", source: fixture.url, args: ["--major"] })
    expect(result.code).toBe(0)
    expect(result.output).toContain("Upgrade complete")
    const expected = new Bun.CryptoHasher("sha256").update(executable(patched)).digest("hex")
    expect(await digest(result.binary)).toBe(expected)
  })

  test("refuses a target on the older line", async () => {
    const fixture = await start([{ tag: "v1.18.34-patched.5" }])
    const result = await upgrade({ version: patched, source: fixture.url, args: ["1.18.34-patched.5"] })
    const before = await digest(result.binary)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("not newer")
    expect(await digest(result.binary)).toBe(before)
  })

  test("keeps a source checkout out of the patched install", async () => {
    const fixture = await start([{ tag: `v${patched}` }])
    const result = await upgrade({ version: "2.0.26-patched.0", source: fixture.url, installed: false })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("not a patched install")
  })
})
