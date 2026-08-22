// bun >=1.4 surfaces EPIPE from writes to a torn-down channel as a fatal
// error instead of swallowing it (oven-sh/bun#35064, "stdio: surface EPIPE
// from console.log/process.stdout.write as 'error'"). The TUI/server/worker
// processes legitimately race channel teardown, so absorb broken-pipe errors
// process-wide (as bun <=1.3/node did) and keep running. Any other uncaught
// error still terminates the process (print + exit 1), preserving the
// default fatal behavior for genuine bugs.
function isBrokenPipe(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined
  if (code === "EPIPE") return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("EPIPE") || message.includes("broken pipe")
}
function absorbBrokenPipe(error: unknown) {
  if (!isBrokenPipe(error)) return false
  if (process.env.OPENCODE_LOG_LEVEL === "debug") {
    console.error(`[broken-pipe absorbed pid=${process.pid}]`, error instanceof Error ? error.message : String(error))
  }
  return true
}
function installBrokenPipeGuard() {
  process.on("uncaughtException", (error) => {
    if (absorbBrokenPipe(error)) return
    console.error(error)
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    if (absorbBrokenPipe(reason)) return
    console.error(reason)
    process.exit(1)
  })
  for (const stream of [process.stdout, process.stderr]) {
    stream.on?.("error", absorbBrokenPipe)
  }
}
installBrokenPipeGuard()

const profile = process.env.OPENCODE_CPU_PROFILE?.replace("{pid}", String(process.pid))
if (profile) {
  const { Session } = await import("node:inspector")
  let session: InstanceType<typeof Session> | undefined
  let started = false
  process.on("SIGUSR1", () => {
    if (session) return
    const current = new Session()
    session = current
    current.connect()
    current.post("Profiler.enable", (error) => {
      if (error) throw error
      current.post("Profiler.start", (error) => {
        if (error) throw error
        started = true
      })
    })
  })
  process.on("SIGUSR2", () => {
    const current = session
    if (!started || !current) return
    started = false
    current.post("Profiler.stop", (error, result) => {
      if (error) throw error
      void Bun.write(profile, JSON.stringify(result.profile))
      current.post("Profiler.disable", (error) => {
        if (error) throw error
        current.disconnect()
        if (session === current) session = undefined
      })
    })
  })
}

if (process.argv.includes("__opencode_ai_worker__")) {
  await import("./session/llm/ai-process-worker")
} else if (process.argv.includes("__opencode_tui_server__") && process.env.OPENCODE_TUI_SERVER_CHILD) {
  const { runTuiServerChild } = await import("./cli/tui/process-server")
  await runTuiServerChild(JSON.parse(process.env.OPENCODE_TUI_SERVER_CHILD))
  process.exit(0)
} else {
  await import("./index")
}
