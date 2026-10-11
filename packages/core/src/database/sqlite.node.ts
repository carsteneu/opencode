import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { classifySqliteError, LockTimeoutError, SqlError } from "effect/sql/SqlError"
import { Sqlite } from "./sqlite.js"

const TypeId = "~@opencode/core/database/SqliteNode" as const

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

interface Config extends Sqlite.ClientConfig {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly timeout?: number
  readonly allowExtension?: boolean
}

// node:sqlite reports SQLITE_BUSY/SQLITE_LOCKED as `{ code: "ERR_SQLITE_ERROR", errcode: 5|6 }`,
// which classifySqliteError does not read, so a locked statement would surface as an unknown error.
export function classifyNodeSqliteError(cause: unknown, message: string, operation: string) {
  const errcode =
    typeof cause === "object" && cause !== null && "errcode" in cause ? Reflect.get(cause, "errcode") : undefined
  if (typeof errcode === "number" && [5, 6].includes(errcode & 0xff))
    return new LockTimeoutError({ cause, message, operation })
  return classifySqliteError(cause, { message, operation })
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as DatabaseSync

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers))
        try {
          return Effect.succeed(statement.all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyNodeSqliteError(cause, "Failed to execute statement", "execute"),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, SqlClient.SafeIntegers))
        statement.setReturnArrays(true)
        try {
          return Effect.succeed(
            statement.all(...(params as SQLInputValue[])) as unknown as ReadonlyArray<ReadonlyArray<unknown>>,
          )
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyNodeSqliteError(cause, "Failed to execute statement", "execute"),
            }),
          )
        }
      })

    const connection = Sqlite.makeConnection(
      (query, params) =>
        Sqlite.retryLockedStatement(run(query, params), { query, inTransaction: native.isTransaction }),
      (query, params) =>
        Sqlite.retryLockedStatement(runValues(query, params), { query, inTransaction: native.isTransaction }),
      {
        loadExtension: (path: string) =>
          Effect.try({
            try: () => native.loadExtension(path),
            catch: (cause) =>
              new SqlError({
                reason: classifyNodeSqliteError(cause, "Failed to load extension", "loadExtension"),
              }),
          }),
      },
    )

    return yield* Sqlite.makeClient(options, connection, TypeId, (acquirer) => ({
      loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
    }))
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new DatabaseSync(config.filename, {
        readOnly: config.readonly,
        timeout: config.timeout ?? 0,
        allowExtension: config.allowExtension,
        enableForeignKeyConstraints: true,
        open: true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true && config.readonly !== true) native.exec("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const clientLayer = (config: Config) => Layer.effect(SqlClient.SqlClient, make(config))

export const sqliteLayer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, clientLayer(config).pipe(Layer.provide(native))).pipe(Layer.provide(Reactivity.layer))
}
