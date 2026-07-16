const profile = process.env.OPENCODE_CPU_PROFILE?.replace("{pid}", String(process.pid))
if (profile) {
  const { Session } = await import("node:inspector")
  const session = new Session()
  let started = false
  session.connect()
  await new Promise<void>((resolve, reject) =>
    session.post("Profiler.enable", (error) => (error ? reject(error) : resolve())),
  )
  process.on("SIGUSR1", () => {
    if (started) return
    started = true
    session.post("Profiler.start", (error) => {
      if (error) throw error
    })
  })
  process.on("SIGUSR2", () => {
    if (!started) return
    started = false
    session.post("Profiler.stop", (error, result) => {
      if (error) throw error
      void Bun.write(profile, JSON.stringify(result.profile))
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
