import type { Effect } from "effect"

export type RequestValue = null | boolean | number | string | RequestValue[] | { [key: string]: RequestValue }

export interface RequestData {
  readonly headers: Record<string, string>
  readonly body: Record<string, RequestValue>
}

export type RequestTransform = (request: RequestData) => Effect.Effect<RequestData>

export interface CallOptions {
  readonly transformRequest?: RequestTransform
}
