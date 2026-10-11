import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261011235520_session_list_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`session_v2_time_updated_id_idx\` ON \`session_v2\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_v2_project_time_updated_id_idx\` ON \`session_v2\` (\`project_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_v2_directory_time_updated_id_idx\` ON \`session_v2\` (\`directory\`,\`time_updated\`,\`id\`);`,
      )
    })
  },
}

export default migration
