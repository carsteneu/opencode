// Standalone Ghostty interaction gate for the TUI session-dialog regression.
// Usage: bun run gate.ts <binary> [label]
// Classifies: GOOD (dialog rendered, Escape works, Ctrl-C exits, no crash),
//             CRASH (crash pattern detected), HANG (dialog gray/unresponsive), FAIL (other)
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const binary = process.argv[2]
if (!binary) {
  console.error("usage: bun run gate.ts <binary> [label]")
  process.exit(2)
}
const label = process.argv[3] ?? path.basename(binary)
const verifyBinStat = async () => {
  const s = await stat(binary)
  if (!s.isFile()) throw new Error(`${binary} is not a file`)
}
await verifyBinStat()

const crashPattern =
  /opencode crashed|An unexpected error stopped the session|EditorView is destroyed|TextBufferView is destroyed|Failed to (?:get|create) TextBuffer|tui bootstrap failed/i

const smoke = await mkdtemp(path.join(tmpdir(), "oc-gate-"))
const data = path.join(smoke, "data")
const config = path.join(smoke, "config")
const state = path.join(smoke, "state")
const transcript = path.join(smoke, "transcript.io")
const launcher = path.join(smoke, "launch.sh")
const tmuxLauncher = path.join(smoke, "launch-tmux.sh")
const tmuxSocket = `oc-gate-${process.pid}-${Date.now()}`

await writeFile(
  launcher,
  [
    `#!/bin/sh`,
    `export XDG_DATA_HOME=${JSON.stringify(data)}`,
    `export XDG_CONFIG_HOME=${JSON.stringify(config)}`,
    `export XDG_STATE_HOME=${JSON.stringify(state)}`,
    `export OPENCODE_CONFIG_CONTENT='{}'`,
    `export OPENCODE_DISABLE_PROJECT_CONFIG=1`,
    `export OPENCODE_DISABLE_DEFAULT_PLUGINS=1`,
    `export OPENCODE_DISABLE_EXTERNAL_SKILLS=1`,
    `export OPENCODE_DISABLE_CLAUDE_CODE=1`,
    `export OPENCODE_DISABLE_LSP_DOWNLOAD=1`,
    `export OPENCODE_SHOW_TTFD=1`,
    `exec ${JSON.stringify(binary)}`,
  ].join("\n"),
)
await chmod(launcher, 0o755)
await writeFile(
  tmuxLauncher,
  `#!/bin/sh\nexec tmux -L ${JSON.stringify(tmuxSocket)} new-session -s smoke ${JSON.stringify(launcher)}\n`,
)
await chmod(tmuxLauncher, 0o755)

const tmux = "tmux"
const ghosttyChild = Bun.spawn(
  ["timeout", "45", "ghostty", "--gtk-single-instance=false", "--window-decoration=false", "-e", "script", "-qfec", tmuxLauncher, transcript],
  { stdout: "pipe", stderr: "pipe" },
)
const ghosttyStdout = new Response(ghosttyChild.stdout).text()
const ghosttyStderr = new Response(ghosttyChild.stderr).text()

const applicationLog = Bun.file(path.join(data, "opencode/log/opencode.log"))
const crashLog = Bun.file(path.join(state, "opencode/tui-crash.log"))

const captureNow = async () => {
  const r = Bun.spawn([tmux, "-L", tmuxSocket, "capture-pane", "-p", "-t", "smoke:0.0"], { stdout: "pipe", stderr: "ignore" })
  return new Response(r.stdout).text()
}
const diagnostic = async () =>
  [
    await captureNow(),
    (await Bun.file(transcript).exists()) ? await Bun.file(transcript).text() : "",
    (await applicationLog.exists()) ? await applicationLog.text() : "",
    (await crashLog.exists()) ? await crashLog.text() : "",
  ].join("\n")
const send = (...keys: string[]) => Bun.spawn([tmux, "-L", tmuxSocket, "send-keys", "-t", "smoke:0.0", ...keys], { stderr: "ignore" })

const waitFor = async <T>(check: () => Promise<T | undefined>, timeout: number, message: string): Promise<T> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== undefined) return result
    await Bun.sleep(50)
  }
  throw new Error(message)
}

let result: { verdict: string; detail: string; artifacts: string }
try {
  await waitFor(
    async () => {
      const r = Bun.spawn([tmux, "-L", tmuxSocket, "has-session", "-t", "smoke"], { stdout: "pipe", stderr: "ignore" })
      await new Response(r.stdout).text()
      return (await new Response(r.stderr).text()) === "" ? true : undefined
    },
    10_000,
    "no tmux session",
  )
  const firstDraw = await waitFor(
    async () => {
      const output = await diagnostic()
      if (crashPattern.test(output)) throw new Error("crash detected before first draw")
      return output.match(/Time to first draw: [0-9.]+/i)?.[0]
    },
    15_000,
    "no first draw",
  )

  for (let index = 0; index < 3; index++) {
    await send("-l", "/sessions")
    await waitFor(
      async () => ((await captureNow()).includes("Switch session") ? true : undefined),
      10_000,
      "could not select /sessions",
    )
    await send("Enter")
    await waitFor(
      async () => {
        const output = await diagnostic()
        if (crashPattern.test(output)) throw new Error("crash during dialog")
        return !(await captureNow()).includes("Switch session") ? true : undefined
      },
      10_000,
      "did not execute /sessions",
    )
    await Bun.sleep(100)
    if (crashPattern.test(await diagnostic())) throw new Error("crash after dialog")
    await send("Escape")
    await Bun.sleep(50)
  }

  await send("C-c")
  await waitFor(async () => (ghosttyChild.exitCode === null ? undefined : true), 10_000, "no exit on Ctrl-C")
  const output = [await diagnostic(), await ghosttyStdout, await ghosttyStderr].join("\n")
  if (crashPattern.test(output)) throw new Error("crash at end")
  result = { verdict: "GOOD", detail: `firstDraw=${firstDraw}`, artifacts: smoke }
} catch (error) {
  const output = await diagnostic()
  const crashed = crashPattern.test(output)
  const hung = /no exit on Ctrl-C|did not execute \/sessions|could not select \/sessions/.test(
    error instanceof Error ? error.message : "",
  )
  const verdict = crashed ? "CRASH" : hung ? "HANG" : "FAIL"
  if (verdict === "HANG") {
    // check whether pane still shows the dialog or a gray wall
    const pane = await captureNow()
    const dialogVisible = pane.includes("Sessions") || pane.includes("Switch session")
    result = {
      verdict,
      detail: `dialogVisible=${dialogVisible} ${error instanceof Error ? error.message : String(error)}`,
      artifacts: smoke,
    }
  } else {
    result = { verdict, detail: error instanceof Error ? error.message : String(error), artifacts: smoke }
  }
} finally {
  if (ghosttyChild.exitCode === null) ghosttyChild.kill()
  Bun.spawn([tmux, "-L", tmuxSocket, "kill-server"], { stderr: "ignore" })
  // keep artifacts for HANG/CRASH so they can be inspected; remove for GOOD
  if (result?.verdict === "GOOD") await rm(smoke, { recursive: true, force: true })
}

console.log(JSON.stringify({ label, ...result }))
