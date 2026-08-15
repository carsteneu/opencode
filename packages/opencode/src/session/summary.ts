import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { Deferred, Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

function mapUnquoted(diffs: readonly Snapshot.FileDiff[]): Snapshot.FileDiff[] {
  return diffs.map((item) => {
    if (item.file === undefined) return item
    const file = unquoteGitPath(item.file)
    if (file === item.file) return item
    return { ...item, file }
  })
}

function snapshotRange(messages: readonly SessionV1.WithParts[]) {
  let from: string | undefined
  let to: string | undefined
  let boundary: "start" | "finish" | undefined
  for (const item of messages) {
    for (const part of item.parts) {
      if (part.type === "step-start") {
        boundary = "start"
        if (!from && part.snapshot) from = part.snapshot
      }
      if (part.type === "step-finish") {
        boundary = "finish"
        to = part.snapshot
      }
    }
  }
  if (from && to && boundary === "finish") return { from, to }
}

function pendingStep(messages: readonly SessionV1.WithParts[]) {
  let pending: { snapshot?: string } | undefined
  for (const item of messages) {
    for (const part of item.parts) {
      if (part.type === "step-start") pending = part.snapshot ? { snapshot: part.snapshot } : {}
      if (part.type === "step-finish") pending = undefined
    }
  }
  return pending
}

export interface Interface {
  readonly reset: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly materialize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly materializeSession: (input: { sessionID: SessionID }) => Effect.Effect<MessageID[]>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly hydrate: <T extends SessionV1.Info>(
    info: T,
    messages?: readonly SessionV1.WithParts[],
    options?: { readonly persist?: boolean },
  ) => Effect.Effect<T>
  readonly hydrateMessages: (
    messages: readonly SessionV1.WithParts[],
    options?: { readonly persist?: boolean },
  ) => Effect.Effect<SessionV1.WithParts[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messageDiffs = yield* MessageDiff.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const active = new Map<string, { again: boolean; done: Deferred.Deferred<void> }>()
    const finishing = new Set<string>()

    const reset = Effect.fn("SessionSummary.reset")(function* (input: { sessionID: SessionID }) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
    })

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      const range = snapshotRange(input.messages)
      if (range) return yield* snapshot.diffFull(range.from, range.to)
      return []
    })

    const computeSummaryDiff = Effect.fn("SessionSummary.computeSummaryDiff")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      messages: SessionV1.WithParts[]
    }) {
      const range = snapshotRange(input.messages)
      if (!range) return
      const diffs = yield* snapshot.diffSummary(range.from, range.to)
      if (!diffs) return
      const pinned = yield* snapshot.pinDiff({
        sessionID: input.sessionID,
        messageID: input.messageID,
        ...range,
      })
      return { range, diffs, pinned }
    })

    const summarizeOnce = Effect.fn("SessionSummary.summarizeOnce")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if ((yield* config.get()).snapshot === false) return
      const messages = yield* MessageV2.turn(input).pipe(Effect.provideService(Database.Service, database))
      if (!messages.length) return
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const range = snapshotRange(messages)
      if (!range) return
      const existing = yield* messageDiffs.get(input.messageID, input.sessionID)
      if (existing?.fromSnapshot === range.from && existing.toSnapshot === range.to) return
      const result = yield* computeSummaryDiff({ ...input, messages })
      // A pruned legacy snapshot cannot be reconstructed. Keep its existing
      // full patch readable instead of replacing it with incomplete metadata.
      if (result === undefined) return
      const recovered = result.pinned
        ? undefined
        : yield* snapshot.diffFullAvailable(result.range.from, result.range.to)
      if (!result.pinned && recovered === undefined) return
      if (existing) yield* messageDiffs.remove(input.messageID)
      if (recovered)
        yield* messageDiffs.put({
          messageID: input.messageID,
          fromSnapshot: result.range.from,
          toSnapshot: result.range.to,
          diffs: recovered,
        })
      target.info.summary = { ...target.info.summary, diffs: Session.compactSummaryDiffs(result.diffs) }
      yield* sessions.updateMessage(target.info)
      if (recovered) {
        yield* snapshot.unpinDiff(input)
        yield* events.publish(Session.Event.DiffUpdated, input)
      }
    })

    const materializeOnce = Effect.fnUntraced(function* (input: { sessionID: SessionID; messageID: MessageID }) {
      if ((yield* config.get()).snapshot === false) return
      const running = active.get(`${input.sessionID}:${input.messageID}`)
      if (running) yield* Deferred.await(running.done)

      const messages = yield* MessageV2.turn(input).pipe(Effect.provideService(Database.Service, database))
      const message = messages.find((item) => item.info.id === input.messageID)
      if (!message || message.info.role !== "user") return
      const range = snapshotRange(messages)
      const pending = pendingStep(messages)
      const existing = yield* messageDiffs.get(input.messageID)
      if (existing && existing.fromSnapshot === range?.from && existing.toSnapshot === range?.to) {
        yield* snapshot.unpinDiff(input)
        yield* events.publish(Session.Event.DiffUpdated, input)
        return
      }

      const stored = message.info.summary?.diffs
      const legacy =
        stored && stored.length > 0 && stored.every((item) => item.patch !== undefined) ? stored : undefined
      const portable =
        existing && existing.fromSnapshot === undefined && existing.toSnapshot === undefined
          ? existing.diffs
          : undefined
      const pinned = range
        ? yield* snapshot.diffPinned({ ...input, ...range })
        : pending?.snapshot
          ? yield* snapshot.diffPinned({ ...input, excludeTo: pending.snapshot })
          : pending
            ? undefined
            : yield* snapshot.diffPinned(input)
      const diffs = range
        ? (pinned ?? (yield* snapshot.diffFullAvailable(range.from, range.to)) ?? portable ?? legacy)
        : (pinned ?? portable ?? legacy)
      if (diffs === undefined) return

      yield* messageDiffs.put({
        messageID: input.messageID,
        fromSnapshot: range?.from,
        toSnapshot: range?.to,
        diffs,
      })
      message.info.summary = { ...message.info.summary, diffs: Session.compactSummaryDiffs(diffs) }
      yield* sessions.updateMessage(message.info)
      yield* snapshot.unpinDiff(input)
      yield* events.publish(Session.Event.DiffUpdated, input)
    })

    const materialize = Effect.fn("SessionSummary.materialize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const key = `${input.sessionID}:${input.messageID}`
      finishing.add(key)
      return yield* materializeOnce(input).pipe(Effect.ensuring(Effect.sync(() => finishing.delete(key))))
    })

    const materializeSession = Effect.fn("SessionSummary.materializeSession")(function* (input: {
      sessionID: SessionID
    }) {
      const messages = yield* sessions.messages(input).pipe(Effect.orDie)
      const users = new Set(messages.filter((item) => item.info.role === "user").map((item) => item.info.id))
      const candidates = [
        ...new Set(
          messages.flatMap((item) => {
            if (item.info.role === "user") return item.info.summary?.diffs?.length ? [item.info.id] : []
            if (!users.has(item.info.parentID)) return []
            return item.parts.some((part) => part.type === "step-start" || part.type === "step-finish")
              ? [item.info.parentID]
              : []
          }),
        ),
      ]
      const existing = new Set((yield* messageDiffs.manifest([input.sessionID]))[0]?.rows.map((row) => row.messageID))
      yield* Effect.forEach(
        candidates.filter((messageID) => !existing.has(messageID)),
        (messageID) => materialize({ ...input, messageID }),
        { discard: true },
      )
      const complete = new Set((yield* messageDiffs.manifest([input.sessionID]))[0]?.rows.map((row) => row.messageID))
      return candidates.filter((messageID) => !complete.has(messageID))
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const key = `${input.sessionID}:${input.messageID}`
      if (finishing.has(key)) return
      const running = active.get(key)
      if (running) {
        running.again = true
        return yield* Deferred.await(running.done)
      }

      const state = { again: false, done: Deferred.makeUnsafe<void>() }
      active.set(key, state)
      yield* Effect.gen(function* () {
        do {
          state.again = false
          yield* summarizeOnce(input)
        } while (state.again)
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            active.delete(key)
            yield* Deferred.done(state.done, exit)
          }),
        ),
      )
    })

    const resolveDiff = Effect.fn("SessionSummary.resolveDiff")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      messages: readonly SessionV1.WithParts[]
      persist: boolean
    }) {
      const message = input.messages.find((item) => item.info.id === input.messageID)
      if (!message || message.info.role !== "user") return []

      const messages = input.messages.filter(
        (item) =>
          item.info.id === input.messageID ||
          (item.info.role === "assistant" && item.info.parentID === input.messageID),
      )
      const range = snapshotRange(messages)
      const pending = pendingStep(messages)
      const saved = yield* messageDiffs.get(input.messageID, input.sessionID)
      const portable = saved && saved.fromSnapshot === undefined && saved.toSnapshot === undefined
      if (saved && (!range || portable || (saved.fromSnapshot === range.from && saved.toSnapshot === range.to)))
        return mapUnquoted(saved.diffs)

      const stored = message.info.summary?.diffs ?? []
      if (stored.some((item) => item.patch !== undefined)) {
        if (input.persist) {
          yield* messageDiffs.put({
            messageID: input.messageID,
            fromSnapshot: range?.from,
            toSnapshot: range?.to,
            diffs: stored,
          })
          yield* events.publish(Session.Event.DiffUpdated, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          })
        }
        return mapUnquoted(stored)
      }
      const pin = { sessionID: input.sessionID, messageID: input.messageID }
      const pinned = range
        ? yield* snapshot.diffPinned({ ...pin, ...range })
        : pending?.snapshot
          ? yield* snapshot.diffPinned({ ...pin, excludeTo: pending.snapshot })
          : pending
            ? undefined
            : yield* snapshot.diffPinned(pin)
      if (pinned !== undefined) {
        if (input.persist) {
          yield* messageDiffs.put({
            messageID: input.messageID,
            fromSnapshot: range?.from,
            toSnapshot: range?.to,
            diffs: pinned,
          })
          yield* snapshot.unpinDiff(pin)
          yield* events.publish(Session.Event.DiffUpdated, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          })
        }
        return mapUnquoted(pinned)
      }

      if (!range) return mapUnquoted(stored)
      const recomputed = yield* snapshot.diffFullAvailable(range.from, range.to)
      if (recomputed === undefined) return mapUnquoted(stored)
      if (input.persist) {
        yield* messageDiffs.put({
          messageID: input.messageID,
          fromSnapshot: range.from,
          toSnapshot: range.to,
          diffs: recomputed,
        })
        yield* snapshot.unpinDiff(pin)
        yield* events.publish(Session.Event.DiffUpdated, {
          sessionID: input.sessionID,
          messageID: input.messageID,
        })
      }
      return mapUnquoted(recomputed)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const saved = yield* messageDiffs.get(input.messageID, input.sessionID)
      if (saved) return mapUnquoted(saved.diffs)
      const messages = yield* MessageV2.turn({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
        Effect.provideService(Database.Service, database),
      )
      return yield* resolveDiff({ ...input, messageID: input.messageID, messages, persist: true })
    })

    const hydrate = <T extends SessionV1.Info>(
      info: T,
      messages?: readonly SessionV1.WithParts[],
      options?: { readonly persist?: boolean },
    ): Effect.Effect<T> =>
      Effect.gen(function* () {
        if (info.role !== "user") return info
        const stored = info.summary
        if (!stored) return info
        const context =
          messages ??
          (options?.persist === false
            ? yield* sessions.messages({ sessionID: info.sessionID }).pipe(Effect.orDie)
            : undefined)
        return {
          ...info,
          summary: {
            ...stored,
            diffs: yield* context
              ? resolveDiff({
                  sessionID: info.sessionID,
                  messageID: info.id,
                  messages: context,
                  persist: options?.persist !== false,
                })
              : diff({ sessionID: info.sessionID, messageID: info.id }),
          },
        } as T
      }).pipe(Effect.withSpan("SessionSummary.hydrate"))

    const hydrateMessages: Interface["hydrateMessages"] = Effect.fn("SessionSummary.hydrateMessages")(
      function* (messages, options) {
        const children = new Map<MessageID, SessionV1.WithParts[]>()
        messages.forEach((message) => {
          if (message.info.role !== "assistant") return
          const list = children.get(message.info.parentID) ?? []
          list.push(message)
          children.set(message.info.parentID, list)
        })
        return yield* Effect.forEach(messages, (message) => {
          if (message.info.role !== "user" || !message.info.summary) return Effect.succeed(message)
          return hydrate(message.info, [message, ...(children.get(message.info.id) ?? [])], options).pipe(
            Effect.map((info) => (info === message.info ? message : { ...message, info })),
          )
        })
      },
    )

    return Service.of({
      reset,
      summarize,
      materialize,
      materializeSession,
      diff,
      hydrate,
      hydrateMessages,
      computeDiff,
    })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, MessageDiff.node, Snapshot.node, EventV2Bridge.node, Config.node, Database.node],
})

export * as SessionSummary from "./summary"
