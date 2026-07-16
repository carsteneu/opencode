if (process.argv.includes("__opencode_ai_worker__")) {
  await import("./session/llm/ai-process-worker")
} else if (process.argv.includes("__opencode_tui_server__") && process.env.OPENCODE_TUI_SERVER_CHILD) {
  const { runTuiServerChild } = await import("./cli/tui/process-server")
  await runTuiServerChild(JSON.parse(process.env.OPENCODE_TUI_SERVER_CHILD))
  process.exit(0)
} else {
  await import("./index")
}
