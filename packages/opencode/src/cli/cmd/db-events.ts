import { Database } from "@opencode-ai/core/database/database"
import { EventMaintenance } from "@opencode-ai/core/event/maintenance"
import { Effect } from "effect"

export function analyzeEventDatabase(filename: string) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* EventMaintenance.analyze(database.db)
      }).pipe(Effect.provide(Database.readonlyLayerFromPath(filename))),
    ),
  )
}

export function printEventAnalysis(report: Awaited<ReturnType<typeof analyzeEventDatabase>>, format: "json" | "text") {
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return
  }

  process.stdout.write("Event log analysis (read-only)\n")
  process.stdout.write(`Events: ${report.total.events.toLocaleString("en-US")}\n`)
  process.stdout.write(`Aggregates: ${report.total.aggregates.toLocaleString("en-US")}\n`)
  process.stdout.write(`Payload: ${formatBytes(report.total.payloadBytes)}\n`)
  process.stdout.write(
    `Potential repeated snapshot rows: ${report.repeatedSnapshots.events.toLocaleString("en-US")} (${formatBytes(report.repeatedSnapshots.payloadBytes)})\n`,
  )
  process.stdout.write("Apply supported: no\n")
  process.stdout.write("\nBlockers\n")
  for (const [name, value] of Object.entries(report.blockers)) {
    process.stdout.write(`${name}: ${typeof value === "number" ? value.toLocaleString("en-US") : value}\n`)
  }
  process.stdout.write("\nEvent types\n")
  for (const item of report.byType) {
    process.stdout.write(`${item.type}\t${item.events.toLocaleString("en-US")}\t${formatBytes(item.payloadBytes)}\n`)
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}
