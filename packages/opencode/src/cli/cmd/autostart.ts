import type { Argv } from "yargs"
import { installAutostart, removeAutostart, statusAutostart } from "@/server/shared/autostart"

interface AutostartArgs {
  action: "install" | "status" | "remove"
}

export const AutostartCommand = {
  command: "autostart [action]",
  describe: "manage the resident shared-server autostart service (systemd user unit)",
  builder: (yargs: Argv) =>
    yargs.positional("action", {
      type: "string",
      choices: ["install", "status", "remove"],
      default: "install",
      describe: "install (default, idempotent), status, or remove",
    }),
  handler: async (args: AutostartArgs) => {
    if (args.action === "remove") {
      await removeAutostart()
      console.log("autostart removed: disabled, unit and password file deleted")
      return
    }
    if (args.action === "status") {
      console.log(JSON.stringify(await statusAutostart(), null, 2))
      return
    }
    const report = await installAutostart()
    if (!report.supported) {
      console.log(`autostart not available here: ${report.reason}`)
      return
    }
    console.log(
      [
        `password file: ${report.envFileWritten ? "created" : "kept"}`,
        `unit: ${report.unitWritten ? "written" : "unchanged"}`,
        `enabled: ${report.enabled}`,
        report.restarted
          ? "service: restarted (running binary was older than the installed one)"
          : report.started
            ? "service: started"
            : "service: already current",
      ].join("\n"),
    )
  },
}
