import { expect, test } from "bun:test"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { transpilerCache } from "./fixture/environment"

/**
 * The frozen 1.x installer verifies a downloaded patched binary with exactly this
 * comparison (1.x: `smoke.stdout.trim().replace(/^v/, "") !== normalizedTarget`) - no
 * "last token" step, no tolerance. A banner prefix leaves the two sides unequal and
 * aborts the transfer after the download and the checksum have already succeeded, so
 * what the CLI reports for itself is a published contract and is tested as one.
 */
const accepts = (output: string, target: string) => output.trim().replace(/^v/, "") === target

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
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

test("--version prints the version itself, the shape the 1.x installer accepts", async () => {
  const result = await cli(["--version"])

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(result.stdout.trim()).toBe(OPENCODE_VERSION)
  expect(accepts(result.stdout, OPENCODE_VERSION)).toBe(true)
})

test("-v reports the same version as --version", async () => {
  const result = await cli(["-v"])

  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe(OPENCODE_VERSION)
})

test("help and error output keep the default formatting", async () => {
  const help = await cli(["--help"])
  expect(help.exitCode).toBe(0)
  expect(help.stdout).toContain("USAGE")
  expect(help.stdout).toContain("opencode <subcommand> [flags] [<directory>]")

  const unknown = await cli(["--definitely-not-a-flag"])
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stderr).toContain("Unrecognized flag: --definitely-not-a-flag")
})
