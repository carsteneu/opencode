import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"

/**
 * The frozen 1.x installer verifies a downloaded patched binary with exactly this
 * comparison (1.x: `smoke.stdout.trim().replace(/^v/, "") !== normalizedTarget`) - no
 * "last token" step, no tolerance. A banner prefix leaves the two sides unequal and
 * aborts the transfer after the download and the checksum have already succeeded, so
 * what the CLI reports for itself is a published contract and is tested as one.
 */
const accepts = (output: string, target: string) => output.trim().replace(/^v/, "") === target

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    // The developer's own home, config and plugins must not decide this test, and a
    // login shell's OPENCODE_PRINT_LOGS would put the log banner on stderr.
    env: isolatedEnv(root, { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PRINT_LOGS: undefined }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function inIsolatedHome<A>(run: (root: string) => Promise<A>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cli-version-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("--version prints the version itself, the shape the 1.x installer accepts", () =>
  inIsolatedHome(async (root) => {
    const result = await cli(root, ["--version"])

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(result.stdout.trim()).toBe(OPENCODE_VERSION)
    expect(accepts(result.stdout, OPENCODE_VERSION)).toBe(true)
  }))

test("-v reports the same version as --version", () =>
  inIsolatedHome(async (root) => {
    const result = await cli(root, ["-v"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(OPENCODE_VERSION)
  }))

test("help and error output keep the default formatting", () =>
  inIsolatedHome(async (root) => {
    const help = await cli(root, ["--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("USAGE")
    expect(help.stdout).toContain("opencode <subcommand> [flags] [<directory>]")

    const unknown = await cli(root, ["--definitely-not-a-flag"])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain("Unrecognized flag: --definitely-not-a-flag")
  }))
