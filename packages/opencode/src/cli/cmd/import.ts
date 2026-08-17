import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import type { MessageID } from "@/session/schema"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiffTable } from "@opencode-ai/core/database/message-diff.sql"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { eq, inArray } from "drizzle-orm"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

// Bound import size so a single import never monopolizes the DB write lock.
const MAX_IMPORT_MESSAGES = 10_000
const MAX_IMPORT_PARTS = 50_000

/** True when a payload is within import size bounds (checked before the DB transaction). */
export function withinImportLimits(messageCount: number, partCount: number): boolean {
  return messageCount <= MAX_IMPORT_MESSAGES && partCount <= MAX_IMPORT_PARTS
}

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const share = yield* ShareNext.Service
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* Effect.orDie(share.url())
      process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
      process.stdout.write(EOL)
      return
    }

    const baseUrl = new URL(file).origin
    const req = yield* Effect.orDie(share.request())
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
      process.stdout.write(EOL)
      return
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ShareData[]>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    const transformed = transformShareData(shareData)

    if (!transformed) {
      process.stdout.write(`Share not found or empty: ${slug}`)
      process.stdout.write(EOL)
      return
    }

    exportData = transformed
  } else {
    exportData = (yield* fs
      .readJson(file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))) as ExportData
  }

    if (!exportData) {
      process.stdout.write(`Failed to read session data`)
      process.stdout.write(EOL)
      return
    }

    const totalParts = exportData.messages.reduce((n, msg) => n + msg.parts.length, 0)
    if (!withinImportLimits(exportData.messages.length, totalParts)) {
      process.stdout.write(
        `Import aborted: payload too large (${exportData.messages.length} messages, ${totalParts} parts; ` +
          `limit ${MAX_IMPORT_MESSAGES} messages / ${MAX_IMPORT_PARTS} parts)`,
      )
      process.stdout.write(EOL)
      return
    }

    const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  const messages = exportData.messages.map((msg) => ({
    info: decodeMessageInfo(msg.info) as SessionV1.Info,
    parts: msg.parts.map((part) => decodePart(part) as SessionV1.Part),
  }))
  const turnParts = new Map<MessageID, SessionV1.Part[]>()
  messages.forEach((message) => {
    if (message.info.role !== "assistant") return
    const parts = turnParts.get(message.info.parentID) ?? []
    parts.push(...message.parts)
    turnParts.set(message.info.parentID, parts)
  })
  const accepted = yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = messages.length
          ? yield* tx
              .select({ id: MessageTable.id, sessionID: MessageTable.session_id })
              .from(MessageTable)
              .where(
                inArray(
                  MessageTable.id,
                  messages.map((message) => message.info.id),
                ),
              )
              .all()
          : []
        if (existing.some((message) => message.sessionID !== row.id)) return false

        yield* tx
          .insert(SessionTable)
          .values(row)
          .onConflictDoUpdate({
            target: SessionTable.id,
            set: { project_id: row.project_id, directory: row.directory, path: row.path },
          })
          .run()
        yield* tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, row.id)).run()
        yield* tx.delete(MessageTable).where(eq(MessageTable.session_id, row.id)).run()

        for (const msg of messages) {
          const diffs = msg.info.role === "user" ? msg.info.summary?.diffs : undefined
          const portable = diffs?.some((diff) => diff.patch !== undefined) ? diffs : undefined
          const stored = portable
            ? {
                ...msg.info,
                summary: {
                  ...(msg.info.role === "user" && msg.info.summary ? msg.info.summary : {}),
                  diffs: Session.compactSummaryDiffs(portable),
                },
              }
            : msg.info
          const { id, sessionID: _, ...data } = stored
          const parts = turnParts.get(id) ?? []
          const fromSnapshot = parts.find(
            (part): part is SessionV1.StepStartPart => part.type === "step-start" && part.snapshot !== undefined,
          )?.snapshot
          const toSnapshot = parts.findLast(
            (part): part is SessionV1.StepFinishPart => part.type === "step-finish" && part.snapshot !== undefined,
          )?.snapshot

          yield* tx
            .insert(MessageTable)
            .values({
              id,
              session_id: row.id,
              time_created: msg.info.time?.created ?? Date.now(),
              data: data as never,
            })
            .run()

          if (portable)
            yield* tx
              .insert(MessageDiffTable)
              .values({
                message_id: id,
                from_snapshot: fromSnapshot ?? null,
                to_snapshot: toSnapshot ?? null,
                revision: crypto.randomUUID(),
                data: portable,
              })
              .onConflictDoUpdate({
                target: MessageDiffTable.message_id,
                set: {
                  from_snapshot: fromSnapshot ?? null,
                  to_snapshot: toSnapshot ?? null,
                  revision: crypto.randomUUID(),
                  data: portable,
                },
              })
              .run()
          if (msg.parts.length)
            yield* tx
              .insert(PartTable)
              .values(
                msg.parts.map((partInfo) => {
                  const { id: partID, sessionID: _sessionID, messageID: _messageID, ...partData } = partInfo
                  return { id: partID, message_id: id, session_id: row.id, data: partData }
                }),
              )
              .run()
        }
        return true
      }),
    )
    .pipe(Effect.orDie)
  if (!accepted)
    return yield* Effect.fail(
      new CliError({ message: "One or more message IDs already belong to another session and cannot be imported" }),
    )

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
