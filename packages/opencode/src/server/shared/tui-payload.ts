import type { GlobalEvent } from "@opencode-ai/sdk/v2"

export const HEADER = "x-opencode-message-patches"
export const OMIT = "omit"

type MessageInfo = {
  readonly role: string
}

type UserMessageInfo = MessageInfo & {
  readonly role: "user"
  readonly summary?: {
    readonly diffs: ReadonlyArray<{ readonly patch?: string }>
  }
}

export function info<T extends MessageInfo>(value: T): T {
  if (value.role !== "user") return value
  const user = value as T & UserMessageInfo
  const diffs = user.summary?.diffs
  if (!Array.isArray(diffs) || !diffs.some((diff) => diff.patch !== undefined)) return value

  return {
    ...user,
    summary: {
      ...user.summary,
      diffs: diffs.map((diff) => {
        if (diff.patch === undefined) return diff
        const metadata = { ...diff }
        delete metadata.patch
        return metadata
      }),
    },
  } as T
}

export function message<T extends { readonly info: MessageInfo }>(value: T): T {
  const next = info(value.info)
  if (next === value.info) return value
  return { ...value, info: next } as T
}

export function messages<T extends { readonly info: MessageInfo }>(values: readonly T[]) {
  return values.map(message)
}

export function event(value: GlobalEvent): GlobalEvent | undefined {
  if (value.payload.type === "sync") return
  if (value.payload.type !== "message.updated") return value

  const next = info(value.payload.properties.info)
  if (next === value.payload.properties.info) return value
  return {
    ...value,
    payload: {
      ...value.payload,
      properties: {
        ...value.payload.properties,
        info: next,
      },
    },
  }
}

export * as TuiPayload from "./tui-payload"
