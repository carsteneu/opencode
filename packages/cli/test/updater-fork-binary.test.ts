import { afterEach, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { binaryAsset, serve, supported, type Fixture } from "./fixture/fork-channel"

/**
 * End-to-end proof that the fixture release installs a real, locally built
 * patched binary: the release asset is the artifact `build:patched` produces,
 * served over HTTP, and the binary that performs the transfer is a real
 * patched build on the older line.
 */

const cli = path.join(import.meta.dir, "..")
const runtime = Bun.which("bun") ?? process.execPath
const target = "2.0.26-patched.1"
const previous = "1.18.34-patched.0"
const roots: string[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
  fixtures.splice(0).forEach((fixture) => fixture.close())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const digest = async (file: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")

async function build(version: string, outdir: string) {
  const child = Bun.spawn(
    [runtime, "run", "script/build-patched.ts", "--single", "--skip-install", "--skip-web-ui", `--outdir=${outdir}`],
    {
      cwd: cli,
      env: { ...process.env, OPENCODE_VERSION: version },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`build:patched ${version} failed\n${stderr || stdout}`)
  return path.join(outdir, "cli-linux-x64", "bin", "opencode")
}

/** A patched install on the older line, in the layout the install script creates. */
async function install(root: string, source: string) {
  const binary = path.join(root, ".opencode", "bin", "opencode")
  await mkdir(path.dirname(binary), { recursive: true })
  await copyFile(source, binary)
  await chmod(binary, 0o755)
  return binary
}

function upgrade(binary: string, root: string, source: string, args: ReadonlyArray<string> = []) {
  return Bun.spawn([binary, "upgrade", ...args], {
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_FORK_RELEASE_SOURCE: source,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

const version = (binary: string) =>
  Bun.spawnSync([binary, "--version"]).stdout.toString().trim().split(/\s+/).at(-1)?.replace(/^v/, "")

test.skipIf(!supported)(
  "transfers a locally built patched binary to the fixture release",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-fork-e2e-"))
    roots.push(root)
    const asset = await build(target, path.join(root, "target"))
    const binary = await install(root, await build(previous, path.join(root, "previous")))
    expect(version(binary)).toBe(previous)

    const fixture = await serve([{ tag: `v${target}`, binary: { file: asset } }])
    fixtures.push(fixture)
    const child = upgrade(binary, root, fixture.url, ["--major"])
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = stripVTControlCharacters(`${stdout}\n${stderr}`)
    expect(code, output).toBe(0)
    expect(output).toContain("Upgrade complete")
    expect(version(binary)).toBe(target)
    expect(await digest(binary)).toBe(await digest(asset))
  },
  300000,
)

test.skipIf(!supported)(
  "keeps a locally built patched binary when the release checksum is wrong",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-fork-e2e-"))
    roots.push(root)
    const asset = await build(target, path.join(root, "target"))
    const binary = await install(root, await build(previous, path.join(root, "previous")))

    const fixture = await serve([
      { tag: `v${target}`, binary: { file: asset }, checksum: `${"0".repeat(64)}  ${binaryAsset}\n` },
    ])
    fixtures.push(fixture)
    const child = upgrade(binary, root, fixture.url, ["--major"])
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = stripVTControlCharacters(`${stdout}\n${stderr}`)
    expect(code, output).not.toBe(0)
    expect(output).toContain("checksum")
    expect(version(binary)).toBe(previous)
    expect(await digest(binary)).not.toBe(await digest(asset))
  },
  300000,
)
