import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { createQueuedClient } from "./sdk-queued"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string | Promise<string>
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    // The server URL only resolves once the child process reports ready. The
    // queued client lets the shell draw immediately; nothing blocks on the
    // server finishing its boot.
    const sdk = createQueuedClient({
      url: props.url,
      create: (baseUrl) =>
        createOpencodeClient({
          baseUrl,
          signal: abort.signal,
          directory: props.directory,
          fetch: props.fetch,
          headers: props.headers,
        }),
    })
    const { client, connected } = sdk

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently, batch this with future events so sustained
      // streams (message.part.delta) coalesce into ~10 flushes/s instead of 60.
      // Isolated events still flush immediately to avoid latency.
      // Note: 250ms was A/B-tested (patched.6) and brought no measurable gain
      // over 100ms — the remaining cost is per-token (JSON parse, server-side
      // effect fibers) and per-frame draw, not flush count.
      if (elapsed < 100) {
        timer = setTimeout(flush, 100)
        return
      }
      flush()
    }

    function startSSE() {
      abortQuietly(sse)
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await client.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await client.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await client.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abortQuietly(abort)
      abortQuietly(sse)
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return client
      },
      connected,
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})

function abortQuietly(controller: AbortController | undefined) {
  if (!controller || controller.signal.aborted) return
  try {
    controller.abort()
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") throw error
  }
}
