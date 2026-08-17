import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Duration, Effect, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { downloadBounded, fetchBoundedBody, fetchBoundedText } from "@opencode-ai/core/http/bounded-download"
import { tmpdir } from "./fixture/tmpdir"

const MAX = 5 * 1024 * 1024

const stub = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) =>
    Effect.sync(() => handler(request)).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  )

const failure = async (eff: Effect.Effect<unknown, Error>): Promise<Error> => {
  try {
    await Effect.runPromise(eff)
  } catch (cause) {
    return cause as Error
  }
  throw new Error("expected the effect to fail")
}

const options = { maxBytes: MAX, timeout: Duration.seconds(5) }

describe("fetchBoundedBody", () => {
  test("returns the body and content type", async () => {
    const http = stub(
      () => new Response("# hi", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    )
    const { body, contentType } = await Effect.runPromise(fetchBoundedBody(http, "https://example.test/a.md", options))
    expect(new TextDecoder().decode(body)).toBe("# hi")
    expect(contentType).toBe("text/plain; charset=utf-8")
  })

  test("rejects a body whose Content-Length exceeds the cap before reading it", async () => {
    const http = stub(
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(MAX + 1) },
        }),
    )
    const error = await failure(fetchBoundedBody(http, "https://example.test/big.md", options))
    expect(error.message).toMatch(/too large/i)
  })

  test("aborts mid-read when the body exceeds the cap without a Content-Length", async () => {
    const http = stub(() => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("a".repeat(MAX + 1)))
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      )
    })
    const error = await failure(fetchBoundedBody(http, "https://example.test/big.bin", options))
    expect(error.message).toMatch(/too large/i)
  })

  test("rejects a content type outside the allowlist", async () => {
    const http = stub(
      () => new Response("data", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    )
    const error = await failure(
      fetchBoundedBody(http, "https://example.test/x.bin", {
        ...options,
        allowContentType: (mime) => mime.startsWith("text/"),
      }),
    )
    expect(error.message).toMatch(/content type/i)
  })

  test("allows binary content types when no allowlist is set", async () => {
    const http = stub(
      () => new Response("data", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    )
    const { body } = await Effect.runPromise(fetchBoundedBody(http, "https://example.test/x.bin", options))
    expect(new TextDecoder().decode(body)).toBe("data")
  })

  test("times out when the server never responds", async () => {
    const http = HttpClient.make(() => Effect.never)
    const error = await failure(
      fetchBoundedBody(http, "https://example.test/slow", { maxBytes: MAX, timeout: Duration.millis(10) }),
    )
    expect(error.message).toMatch(/timed out/i)
  })
})

describe("fetchBoundedText", () => {
  test("decodes the body to a string", async () => {
    const http = stub(() => new Response("# Rules", { status: 200, headers: { "content-type": "text/markdown" } }))
    const text = await Effect.runPromise(fetchBoundedText(http, "https://example.test/rules.md", options))
    expect(text).toBe("# Rules")
  })
})

describe("downloadBounded", () => {
  test("writes the body to the destination and leaves no temp file behind", async () => {
    const tmp = await tmpdir()
    try {
      const http = stub(() => new Response("# Skill", { status: 200, headers: { "content-type": "text/markdown" } }))
      const dest = path.join(tmp.path, "skills", "prod", "SKILL.md")
      const run = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* downloadBounded(fs, http, "https://example.test/SKILL.md", dest, options)
      })
      await Effect.runPromise(Effect.provide(run, NodeFileSystem.layer))

      expect(await fs.readFile(dest, "utf8")).toBe("# Skill")
      expect((await fs.readdir(path.dirname(dest))).some((entry) => entry.includes(".download-"))).toBe(false)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("does not leave a partial file at the destination when the download fails", async () => {
    const tmp = await tmpdir()
    try {
      const http = stub(
        () =>
          new Response("x", {
            status: 200,
            headers: { "content-type": "text/plain", "content-length": String(MAX + 1) },
          }),
      )
      const dest = path.join(tmp.path, "out.md")
      const run = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* downloadBounded(fs, http, "https://example.test/out.md", dest, options)
      })
      const error = await failure(run.pipe(Effect.provide(NodeFileSystem.layer)))
      expect(error.message).toMatch(/too large/i)
      await expect(fs.readFile(dest, "utf8")).rejects.toThrow()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})
