import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260817153515_normalize_assistant_content",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_message_content\` (
          \`message_id\` text NOT NULL,
          \`item_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_message_content_pk\` PRIMARY KEY(\`message_id\`, \`item_id\`),
          CONSTRAINT \`fk_session_message_content_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_message_content_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_message_content_message_seq_idx\` ON \`session_message_content\` (\`message_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_content_session_seq_idx\` ON \`session_message_content\` (\`session_id\`,\`seq\`);`,
      )
      // Backfill: existing assistant rows stored their content inline in the
      // projection blob. Split each item into its own segment row (sequenced
      // after the message so reassembly preserves append order) and clear the
      // blob so the header row no longer grows with the conversation.
      yield* tx.run(`
        INSERT INTO \`session_message_content\` (\`message_id\`, \`item_id\`, \`session_id\`, \`seq\`, \`data\`)
        SELECT
          m.id,
          json_extract(item.value, '$.id'),
          m.session_id,
          m.seq + item.key,
          item.value
        FROM \`session_message\` m
        JOIN json_each(json_extract(m.data, '$.content')) AS item
        WHERE m.type = 'assistant'
          AND json_extract(m.data, '$.content') IS NOT NULL
          AND json_extract(item.value, '$.id') IS NOT NULL;
      `)
      yield* tx.run(`
        UPDATE \`session_message\`
        SET data = json_set(data, '$.content', json_array())
        WHERE type = 'assistant';
      `)
    })
  },
} satisfies DatabaseMigration.Migration
