import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260817000652_session_list_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_project_idx\`;`)
      yield* tx.run(`CREATE INDEX \`session_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_project_time_updated_id_idx\` ON \`session\` (\`project_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_time_updated_id_idx\` ON \`session\` (\`directory\`,\`time_updated\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
