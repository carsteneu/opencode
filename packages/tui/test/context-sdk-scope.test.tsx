/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider, useSDK } from "../src/context/sdk"
import { createFetch, directory, eventSource, json } from "./fixture/tui-sdk"

test("the TUI declares an event scope carrying its client id", async () => {
  const seen = Promise.withResolvers<{ body: Record<string, unknown>; headers: Headers }>()
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/global/scope") {
      seen.resolve({ body: (await request.json()) as Record<string, unknown>, headers: request.headers })
      return json(true)
    }
    return undefined
  })

  function Harness() {
    const sdk = useSDK()
    onMount(() => {
      void sdk.scope(["ses_root"])
    })
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
      <Harness />
    </SDKProvider>
  ))
  try {
    const { body, headers } = await seen.promise
    expect(String(body.clientID)).toStartWith("tui_")
    expect(body.directory).toBe(directory)
    expect(body.sessions).toEqual(["ses_root"])
    // The stream carries the same id, so the server can match declaration and stream.
    expect(headers.get("x-opencode-client-id")).toBe(String(body.clientID))
  } finally {
    app.renderer.destroy()
  }
})
