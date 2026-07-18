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
