import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { collectBoundedResponseBody } from "@opencode-ai/core/tool/http-body"

const collect = (request: HttpClientRequest.HttpClientRequest, response: Response) =>
  collectBoundedResponseBody(HttpClientResponse.fromWeb(request, response), 1024, () => new Error("too large"))

test.each([
  ["200 null body", HttpClientRequest.get("https://example.com/empty"), new Response(null)],
  ["204 response", HttpClientRequest.get("https://example.com/no-content"), new Response(null, { status: 204 })],
  ["205 response", HttpClientRequest.get("https://example.com/reset-content"), new Response(null, { status: 205 })],
  ["HEAD response", HttpClientRequest.head("https://example.com/head"), new Response(null)],
])("collectBoundedResponseBody treats %s as an empty buffer", async (_, request, response) => {
  expect(await Effect.runPromise(collect(request, response))).toEqual(Buffer.alloc(0))
})

test("collectBoundedResponseBody preserves response stream failures", async () => {
  const failure = new Error("response stream failed")
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(failure)
      },
    }),
  )

  const exit = await Effect.runPromiseExit(collect(HttpClientRequest.get("https://example.com/failure"), response))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toMatchObject({ reason: { _tag: "DecodeError", cause: failure } })
  }
})

test("collectBoundedResponseBody preserves transport failures", async () => {
  const request = HttpClientRequest.get("https://example.com/transport-failure")
  const response = HttpClientResponse.fromWeb(request, new Response(null))
  const error = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause: new Error("transport failed") }),
  })
  Object.defineProperty(response, "stream", { get: () => Stream.fail(error) })

  const exit = await Effect.runPromiseExit(collectBoundedResponseBody(response, 1024, () => new Error("too large")))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error)
})

test("collectBoundedResponseBody rejects EmptyBodyError after receiving bytes", async () => {
  const request = HttpClientRequest.get("https://example.com/partial")
  const response = HttpClientResponse.fromWeb(request, new Response(null))
  const error = new HttpClientError.HttpClientError({
    reason: new HttpClientError.EmptyBodyError({ request, response }),
  })
  Object.defineProperty(response, "stream", {
    get: () => Stream.concat(Stream.succeed(Uint8Array.of(120)), Stream.fail(error)),
  })

  const exit = await Effect.runPromiseExit(collectBoundedResponseBody(response, 1024, () => new Error("too large")))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error)
})
