import { Duration, Effect, Stream } from "effect"
import { LLMError, TimeoutReason } from "../../schema"

type Timeout = number | false | undefined

type Input = {
  readonly module: string
  readonly phase: "headers" | "chunk"
  readonly timeout: Timeout
}

const error = (input: Input & { readonly timeout: number }) =>
  new LLMError({
    module: input.module,
    method: input.phase,
    reason: new TimeoutReason({
      message:
        input.phase === "headers"
          ? `Provider response headers timed out after ${input.timeout}ms`
          : `Provider response stream timed out after ${input.timeout}ms`,
      phase: input.phase,
      timeoutMs: input.timeout,
    }),
  })

const effect = <A, E, R>(self: Effect.Effect<A, E, R>, input: Input) => {
  const timeout = input.timeout
  if (timeout === undefined || timeout === false) return self
  return Effect.timeoutOrElse(self, {
    duration: Duration.millis(timeout),
    orElse: () => Effect.fail(error({ ...input, timeout })),
  })
}

const stream = <A, E, R>(self: Stream.Stream<A, E, R>, input: Input) => {
  const timeout = input.timeout
  if (timeout === undefined || timeout === false) return self
  return Stream.timeoutOrElse(self, {
    duration: Duration.millis(timeout),
    orElse: () => Stream.fail(error({ ...input, timeout })),
  })
}

export const TransportTimeout = { effect, stream } as const
