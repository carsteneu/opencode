/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider, useSDK } from "../src/context/sdk"
import { directory, json } from "./fixture/tui-sdk"

const dead = "http://dead"
const revived = "http://revived"

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// A window attached to a shared server must not stay dark when that server dies.
// The stream of the dead server ends, the window runs discovery again (the
// resolver returns a different, live server here), re-points the client and
// resubscribes — including re-declaring its scope against the new server.
test("a window re-discovers the shared server after its stream ends", async () => {
  const events: string[] = []
  const scopes: string[] = []
  let redials = 0

  const serverSentEvents = (body: BodyInit) =>
    new Response(body, { headers: { "content-type": "text/event-stream" } })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/global/event") {
      events.push(url.origin)
      // The dead server answers with an immediately-finished stream; the live
      // one streams for as long as the test needs it.
      if (url.origin === dead) return serverSentEvents("")
      return serverSentEvents(new ReadableStream<Uint8Array>({ start() {} }))
    }
    if (url.pathname === "/global/scope") {
      scopes.push(url.origin)
      return json(true)
    }
    return json({})
  }) as typeof fetch

  function Harness() {
    const sdk = useSDK()
    onMount(() => {
      void sdk.scope(["ses_root"])
    })
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider
      url={dead}
      directory={directory}
      fetch={fetchImpl}
      rediscover={async () => {
        redials += 1
        return { url: revived, headers: { Authorization: "Basic revived" } }
      }}
    >
      <Harness />
    </SDKProvider>
  ))
  try {
    await wait(() => events.includes(revived))
    await wait(() => scopes.includes(revived))
    expect(events).toContain(dead)
    expect(redials).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
