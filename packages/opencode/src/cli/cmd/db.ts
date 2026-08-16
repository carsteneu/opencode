import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { CliError, effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"
import { isAbsolute } from "path"

type EventsArgs = {
  database: string
  format: "json" | "text"
}

const EventsCommand = cmd<{}, EventsArgs>({
  command: "events",
  describe: "analyze event log growth without modifying the database",
  builder: (yargs) =>
    yargs
      .option("database", {
        type: "string",
        demandOption: true,
        describe: "absolute path to the database file to analyze",
      })
      .option("format", {
        type: "string",
        choices: ["json", "text"] as const,
        default: "text" as const,
        describe: "output format",
      }),
  async handler(args) {
    if (!isAbsolute(args.database)) {
      throw new CliError({ message: "--database must be an absolute path" })
    }
    if (!(await Bun.file(args.database).exists())) {
      throw new CliError({ message: `Database does not exist: ${args.database}` })
    }
    const { analyzeEventDatabase, printEventAnalysis } = await import("./db-events")
    printEventAnalysis(await analyzeEventDatabase(args.database), args.format)
  },
})

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(EventsCommand).demandCommand()
  },
  async handler() {},
})
