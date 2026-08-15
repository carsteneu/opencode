import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815222004_message_diff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`message_diff\` (
          \`message_id\` text PRIMARY KEY,
          \`from_snapshot\` text,
          \`to_snapshot\` text,
          \`revision\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_diff_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "message_diff_message_id_not_null" CHECK("message_id" IS NOT NULL)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
