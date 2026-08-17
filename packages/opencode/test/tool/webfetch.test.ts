import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { MAX_RESPONSE_SIZE, WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

let respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
const mocked = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          respond().pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
        ),
      ),
    ],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("returns empty text for no-content responses", () =>
    withFetch(
      () => new Response(null, { status: 204, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/empty", url).toString(), format: "text" })
          expect(result.output).toBe("")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  mocked.instance("rejects declared oversized bodies before reading them", () =>
    Effect.gen(function* () {
      let pulled = false
      respond = () =>
        Effect.succeed(
          new Response(
            new ReadableStream({
              pull() {
                pulled = true
              },
            }),
            {
              headers: {
                "content-type": "text/plain",
                "content-length": String(MAX_RESPONSE_SIZE + 1),
              },
            },
          ),
        )

      const exit = yield* Effect.exit(exec({ url: "https://example.com/declared", format: "text" }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Response too large")
      expect(pulled).toBe(false)
    }),
  )

  mocked.instance("stops streamed bodies at the hard byte limit", () =>
    Effect.gen(function* () {
      const chunk = new Uint8Array(64 * 1024).fill(120)
      let produced = 0
      let cancelled = false
      respond = () =>
        Effect.succeed(
          new Response(
            new ReadableStream({
              pull(controller) {
                produced += chunk.byteLength
                controller.enqueue(chunk)
              },
              cancel() {
                cancelled = true
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
        )

      const exit = yield* Effect.exit(exec({ url: "https://example.com/chunked", format: "text" }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Response too large")
      expect(produced).toBeLessThanOrEqual(MAX_RESPONSE_SIZE + chunk.byteLength)
      expect(cancelled).toBe(true)
    }),
  )

  mocked.instance("applies the request timeout while collecting the body", () =>
    Effect.gen(function* () {
      let release: (() => void) | undefined
      let cancelled = false
      respond = () =>
        Effect.succeed(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise<void>((resolve) => {
                  release = resolve
                })
              },
              cancel() {
                cancelled = true
                release?.()
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
        )

      const exit = yield* Effect.exit(exec({ url: "https://example.com/stalled", format: "text", timeout: 0.05 }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Request timed out")
      expect(cancelled).toBe(true)
    }),
  )
})
