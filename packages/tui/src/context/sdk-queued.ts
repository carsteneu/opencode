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
  let url = Promise.resolve(input.url)
  let real: C | undefined
  let connectionError: unknown
  let generation = 0
  const [connected, setConnected] = createSignal(false)
  const bind = (pending: Promise<string>) => {
    // Only the latest bind may install a client: a URL promise that settles after
    // a retarget must not point the client back at the server it just left.
    const mine = ++generation
    pending.then(
      (baseUrl) => {
        if (mine !== generation) return
        real = input.create(baseUrl)
        setConnected(true)
      },
      (error) => {
        if (mine !== generation) return
        connectionError = error
        setConnected(true)
      },
    )
  }
  bind(url)

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

  return {
    client,
    connected,
    get url() {
      return url
    },
    /**
     * Point the client at a server discovered later, after the one it attached
     * to died. The next call builds a fresh SDK against the new base URL; a call
     * already in flight keeps the URL it started with.
     */
    retarget(next: string) {
      real = undefined
      connectionError = undefined
      url = Promise.resolve(next)
      bind(url)
    },
  }
}
