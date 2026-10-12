import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { Host } from "@opencode/plugin/host"
import { yesmemEntry } from "./opencode-yesmem-fixture"

type HttpModule = { readBodyCapped: (response: Response, maxChars?: number) => Promise<string> }

/** Streams far more than the budget so a naive reader would buffer the whole body. */
async function streamingServer(chunkCount: number) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    const chunk = "x".repeat(64 * 1024)
    let sent = 0
    const timer = setInterval(() => {
      if (sent++ >= chunkCount) {
        clearInterval(timer)
        response.end()
        return
      }
      response.write(chunk)
    }, 1)
    response.on("close", () => clearInterval(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe("capped body reader", () => {
  test("stops reading at the budget instead of buffering the whole body", async () => {
    const module = (await Host.load(yesmemEntry("http.ts"))) as HttpModule
    const server = await streamingServer(200) // ~12 MiB available
    try {
      const response = await fetch(server.url)
      const body = await module.readBodyCapped(response, 1000)

      expect(body.length).toBe(1000)
    } finally {
      await server.close()
    }
  })

  test("returns the whole body when it fits", async () => {
    const module = (await Host.load(yesmemEntry("http.ts"))) as HttpModule
    const server = await streamingServer(0)
    try {
      const response = await fetch(server.url)
      expect(await module.readBodyCapped(response, 1000)).toBe("")
    } finally {
      await server.close()
    }
  })
})
