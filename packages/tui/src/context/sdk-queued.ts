import { createSignal } from "solid-js"

/**
 * A client whose backing SDK is only created once the server URL resolves.
 * Until then every method call is queued, so the shell can mount and draw
 * frames while the server process finishes booting. If the URL rejects, queued
 * calls fail with the same error instead of hanging forever.
 */
export function createQueuedClient<C extends object>(input: {
  url: string | Promise<string>
  create: (baseUrl: string) => C
}) {
  const url = Promise.resolve(input.url)
  let real: C | undefined
  let connectionError: unknown
  const [connected, setConnected] = createSignal(false)
  url.then(
    (baseUrl) => {
      real = input.create(baseUrl)
      setConnected(true)
    },
    (error) => {
      connectionError = error
      setConnected(true)
    },
  )

  const makeStep = (path: PropertyKey[]): any =>
    new Proxy(function () {} as any, {
      get(_leaf, next: PropertyKey) {
        if (next === "then") return undefined
        return makeStep([...path, next])
      },
      apply(_leaf, _this, args: unknown[]) {
        return url.then(
          (baseUrl) => {
            // Call through the nearest namespace so `this` stays bound (hey-api
            // methods touch `this.client`, which a detached call would lose).
            let target: any = (real ??= input.create(baseUrl))
            let receiver: any = target
            for (const key of path) {
              receiver = target
              target = target[key]
            }
            return target.apply(receiver, args)
          },
          (error) => {
            throw connectionError ?? error
          },
        )
      },
    })

  const client = new Proxy({} as C, {
    get(_target, prop: PropertyKey) {
      if (prop === "then") return undefined
      return makeStep([prop])
    },
  })

  return { client, connected, url }
}
