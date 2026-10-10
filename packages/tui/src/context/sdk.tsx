import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { createQueuedClient } from "./sdk-queued"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export type Rediscover = () => Promise<{ url: string; headers?: RequestInit["headers"] } | undefined>

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string | Promise<string>
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
    rediscover?: Rediscover
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    // Identity for the opt-in event scope. The server only filters the global
    // stream for a client id that declared a scope, so carrying this header is
    // what makes this window opt in — every other subscriber stays unfiltered.
    const clientId = `tui_${Bun.randomUUIDv7()}`
    const headers = { ...Object.fromEntries(new Headers(props.headers as HeadersInit | undefined).entries()) }
    headers["x-opencode-client-id"] = clientId
    let declared: string[] | undefined
    let declaring = false
    // The session list a window renders is project-wide, so R4 has to be keyed on
    // the project and not only on the working directory — otherwise the title,
    // cost, status and deletion of a session that lives in a sibling directory of
    // the same project never arrives and the list goes stale. Declared alongside
    // the directory below.
    let projectID = ""
    // The base URL is re-pointed on rediscovery, so the scope POST follows the
    // window to whatever server it is talking to now.
    let serverUrl: string | Promise<string> = props.url
    const post = async () => {
      const response = await (props.fetch ?? fetch)(new URL("/global/scope", await serverUrl), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          clientID: clientId,
          project: projectID || undefined,
          directory: props.directory,
          sessions: declared ?? [],
        }),
      })
      if (!response.ok) throw new Error(`scope declaration rejected: ${response.status}`)
    }
    // A client that presents the client-id header is filtered from the first
    // frame, so a lost declaration would silently starve this window of its own
    // content. Retry with backoff instead of swallowing the failure.
    const declare = async () => {
      if ((declared === undefined && projectID === "") || declaring) return
      declaring = true
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await post()
            return
          } catch {
            await Bun.sleep(200 * (attempt + 1))
          }
        }
      } finally {
        declaring = false
      }
    }
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
          headers,
        }),
    })
    const { client, connected } = sdk

    // Resolve the project once and hand it to the server with the next
    // declaration. Until it lands R4 falls back to the own-directory decision,
    // which withholds sibling-directory session metadata only.
    const loadProject = async () => {
      const response = await client.project.current().catch(() => undefined)
      const id = response?.data?.id
      if (!id || id === projectID) return
      projectID = id
      await declare()
    }

    // A window attached to a shared server must survive that server dying: run
    // discovery again (a healthy peer is reattached, a dead one is replaced by a
    // freshly started server), re-point the client, and let the loop resubscribe
    // and re-declare the scope. Only the shared path passes a resolver; the IPC
    // path keeps today's behaviour.
    const redial = async () => {
      if (!props.rediscover) return false
      const next = await props.rediscover()
      if (!next) return false
      if (next.headers) {
        const incoming = Object.fromEntries(new Headers(next.headers as HeadersInit).entries())
        delete headers["authorization"]
        Object.assign(headers, incoming)
      }
      serverUrl = next.url
      sdk.retarget(next.url)
      return true
    }

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

          try {
            const events = await client.global.event({
              signal: ctrl.signal,
              sseMaxRetryAttempts: 0,
            })

            // Re-assert the scope on every (re)connect so a reconnect cannot
            // silently widen what this window receives.
            void declare()

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await client.sync.start().catch(() => {})
            }

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              handleEvent(event)
            }
          } catch (error) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            // Without a resolver there is nowhere else to go — the error ends
            // the loop, exactly as before.
            if (!props.rediscover) throw error
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // The stream ended — cleanly or not. Rediscover before retrying so a
          // dead shared server does not leave this window permanently dark.
          if (await redial().catch(() => false)) attempt = 0

          attempt += 1
          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      void loadProject()
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
      get url() {
        return serverUrl
      },
      scope(sessions: string[]) {
        declared = [...sessions]
        return declare()
      },
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
