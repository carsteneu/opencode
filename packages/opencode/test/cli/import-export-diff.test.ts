import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "imports portable full diffs into the side table and exports them again",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const sessionID = "ses_import_diff"
      const messageID = "msg_import_diff"
      const removedMessageID = "msg_import_diff_removed"
      const marker = "portable full patch"
      const file = path.join(home, "portable-session.json")
      const options = { env: { OPENCODE_DB: path.join(home, "opencode.db") } }
      const data = {
        info: {
          id: sessionID,
          slug: "portable-session",
          projectID: "global",
          directory: "/old/project",
          title: "Portable session",
          version: "1.18.18",
          time: { created: 1, updated: 1 },
        },
        messages: [
          {
            info: {
              id: messageID,
              sessionID,
              role: "user",
              time: { created: 2 },
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              summary: {
                diffs: [
                  {
                    file: "portable.ts",
                    patch: marker,
                    additions: 1,
                    deletions: 0,
                    status: "modified",
                  },
                  {
                    file: "metadata-only.ts",
                    additions: 2,
                    deletions: 1,
                    status: "modified",
                  },
                ],
              },
            },
            parts: [],
          },
          {
            info: {
              id: removedMessageID,
              sessionID,
              role: "user",
              time: { created: 3 },
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              summary: { diffs: [] },
            },
            parts: [],
          },
        ],
      }
      yield* Effect.promise(() => Bun.write(file, JSON.stringify(data)))

      const imported = yield* opencode.spawn(["import", file], options)
      opencode.expectExit(imported, 0, "import portable session")
      expect(imported.stdout).toContain(`Imported session: ${sessionID}`)

      const stored = yield* opencode.spawn(
        [
          "db",
          `SELECT 'message' AS source, data FROM message WHERE id = '${messageID}' UNION ALL SELECT 'diff' AS source, data FROM message_diff WHERE message_id = '${messageID}'`,
          "--format",
          "json",
        ],
        options,
      )
      opencode.expectExit(stored, 0, "inspect imported diff")
      const rows = JSON.parse(stored.stdout) as Array<{ source: "message" | "diff"; data: unknown }>
      expect(rows).toHaveLength(2)
      expect(JSON.stringify(rows.find((row) => row.source === "message")?.data)).not.toContain(marker)
      expect(JSON.stringify(rows.find((row) => row.source === "diff")?.data)).toContain(marker)

      const exported = yield* opencode.spawn(["export", sessionID], options)
      opencode.expectExit(exported, 0, "export imported session")
      const output = JSON.parse(exported.stdout) as {
        messages: Array<{ info: { id: string; summary?: { diffs?: Array<{ patch?: string }> } } }>
      }
      expect(output.messages.find((message) => message.info.id === messageID)?.info.summary?.diffs?.[0]?.patch).toBe(
        marker,
      )
      expect(output.messages.find((message) => message.info.id === messageID)?.info.summary?.diffs?.[1]?.patch).toBe(
        undefined,
      )

      const replacementMarker = "same-session replacement patch"
      const replacement = structuredClone(data)
      replacement.messages[0]!.info.summary.diffs[0]!.patch = replacementMarker
      replacement.messages = replacement.messages.slice(0, 1)
      const replacementFile = path.join(home, "replacement-session.json")
      yield* Effect.promise(() => Bun.write(replacementFile, JSON.stringify(replacement)))
      const reimported = yield* opencode.spawn(["import", replacementFile], options)
      opencode.expectExit(reimported, 0, "replace same-session import atomically")

      const replaced = yield* opencode.spawn(["export", sessionID], options)
      opencode.expectExit(replaced, 0, "export replaced same-session import")
      expect(replaced.stdout).toContain(replacementMarker)
      expect(replaced.stdout).not.toContain(marker)
      expect(replaced.stdout).not.toContain(removedMessageID)

      const conflicting = structuredClone(replacement)
      conflicting.info.id = "ses_import_diff_collision"
      conflicting.messages[0]!.info.sessionID = conflicting.info.id
      conflicting.messages[0]!.info.summary.diffs[0]!.patch = "must not overwrite"
      const conflictFile = path.join(home, "conflicting-session.json")
      yield* Effect.promise(() => Bun.write(conflictFile, JSON.stringify(conflicting)))
      const conflict = yield* opencode.spawn(["import", conflictFile], options)
      opencode.expectExit(conflict, 1, "reject cross-session message collision")

      const unchanged = yield* opencode.spawn(
        ["db", `SELECT data FROM message_diff WHERE message_id = '${messageID}'`, "--format", "json"],
        options,
      )
      opencode.expectExit(unchanged, 0, "inspect diff after rejected collision")
      expect(unchanged.stdout).toContain(replacementMarker)
      expect(unchanged.stdout).not.toContain(marker)
      expect(unchanged.stdout).not.toContain("must not overwrite")
    }),
  60_000,
)
