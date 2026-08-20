import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { lazyCommand } from "./cli/lazy-command"
// The $0 default command must stay eager: an async builder on the default
// command makes yargs' callback-form top-level `--help` report empty output.
import { TuiThreadCommand } from "./cli/cmd/tui"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
    .command(
      lazyCommand({ command: "acp", describe: "start ACP (Agent Client Protocol) server" }, () =>
        import("./cli/cmd/acp").then((m) => m.AcpCommand),
      ),
    )
    .command(
      lazyCommand({ command: "mcp", describe: "manage MCP (Model Context Protocol) servers" }, () =>
        import("./cli/cmd/mcp").then((m) => m.McpCommand),
      ),
    )
    .command(TuiThreadCommand)
    .command(
      lazyCommand({ command: "attach <url>", describe: "attach to a running opencode server" }, () =>
        import("./cli/cmd/attach").then((m) => m.AttachCommand),
      ),
    )
    .command(
      lazyCommand({ command: "run [message..]", describe: "run opencode with a message" }, () =>
        import("./cli/cmd/run").then((m) => m.RunCommand),
      ),
    )
    .command(
      lazyCommand({ command: "generate", describe: undefined }, () =>
        import("./cli/cmd/generate").then((m) => m.GenerateCommand),
      ),
    )
    .command(
      lazyCommand({ command: "debug", describe: "debugging and troubleshooting tools" }, () =>
        import("./cli/cmd/debug").then((m) => m.DebugCommand),
      ),
    )
    .command(
      lazyCommand({ command: "console", describe: false }, () =>
        import("./cli/cmd/account").then((m) => m.ConsoleCommand),
      ),
    )
    .command(
      lazyCommand({ command: "providers", aliases: ["auth"], describe: "manage AI providers and credentials" }, () =>
        import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
      ),
    )
    .command(
      lazyCommand({ command: "agent", describe: "manage agents" }, () =>
        import("./cli/cmd/agent").then((m) => m.AgentCommand),
      ),
    )
    .command(
      lazyCommand({ command: "upgrade [target]", describe: "upgrade opencode to the latest or a specific version" }, () =>
        import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand),
      ),
    )
    .command(
      lazyCommand({ command: "uninstall", describe: "uninstall opencode and remove all related files" }, () =>
        import("./cli/cmd/uninstall").then((m) => m.UninstallCommand),
      ),
    )
    .command(
      lazyCommand({ command: "serve", describe: "starts a headless opencode server" }, () =>
        import("./cli/cmd/serve").then((m) => m.ServeCommand),
      ),
    )
    .command(
      lazyCommand({ command: "web", describe: "start opencode server and open web interface" }, () =>
        import("./cli/cmd/web").then((m) => m.WebCommand),
      ),
    )
    .command(
      lazyCommand({ command: "models [provider]", describe: "list all available models" }, () =>
        import("./cli/cmd/models").then((m) => m.ModelsCommand),
      ),
    )
    .command(
      lazyCommand({ command: "stats", describe: "show token usage and cost statistics" }, () =>
        import("./cli/cmd/stats").then((m) => m.StatsCommand),
      ),
    )
    .command(
      lazyCommand({ command: "export [sessionID]", describe: "export session data as JSON" }, () =>
        import("./cli/cmd/export").then((m) => m.ExportCommand),
      ),
    )
    .command(
      lazyCommand({ command: "import <file>", describe: "import session data from JSON file or URL" }, () =>
        import("./cli/cmd/import").then((m) => m.ImportCommand),
      ),
    )
    .command(
      lazyCommand({ command: "github", describe: "manage GitHub agent" }, () =>
        import("./cli/cmd/github").then((m) => m.GithubCommand),
      ),
    )
    .command(
      lazyCommand({ command: "pr <number>", describe: "fetch and checkout a GitHub PR branch, then run opencode" }, () =>
        import("./cli/cmd/pr").then((m) => m.PrCommand),
      ),
    )
    .command(
      lazyCommand({ command: "session", describe: "manage sessions" }, () =>
        import("./cli/cmd/session").then((m) => m.SessionCommand),
      ),
    )
    .command(
      lazyCommand({ command: "plugin <module>", aliases: ["plug"], describe: "install plugin and update config" }, () =>
        import("./cli/cmd/plug").then((m) => m.PluginCommand),
      ),
    )
    .command(
      lazyCommand({ command: "db", describe: "database tools" }, () =>
        import("./cli/cmd/db").then((m) => m.DbCommand),
      ),
    )
    .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
