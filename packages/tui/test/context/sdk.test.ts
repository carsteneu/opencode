import { expect, test } from "bun:test"
import { createQueuedClient } from "../../src/context/sdk-queued"

type Fake = {
  ns: {
    method: (arg: string) => Promise<[string, string]>
    increment: () => Promise<number>
  }
}

function fake(baseUrl: string) {
  let count = 0
  const ns = {
    method: async function (this: unknown, arg: string) {
      if (this !== ns) throw new Error("this binding lost")
      return [baseUrl, arg] as [string, string]
    },
    increment: async function (this: unknown) {
      if (this !== ns) throw new Error("this binding lost")
      return ++count
    },
  }
  return { ns }
}

test("queues calls until the URL resolves, then replays them", async () => {
  const deferred = Promise.withResolvers<string>()
  const queued = createQueuedClient<Fake>({
    url: deferred.promise,
    create: fake,
  })

  expect(queued.connected()).toBe(false)
  const first = queued.client.ns.method("a")
  const second = queued.client.ns.method("b")

  deferred.resolve("http://ready")
  await expect(first).resolves.toEqual(["http://ready", "a"])
  await expect(second).resolves.toEqual(["http://ready", "b"])
  expect(queued.connected()).toBe(true)
})

test("sees mutations through the shared namespace", async () => {
  const deferred = Promise.withResolvers<string>()
  const queued = createQueuedClient<Fake>({
    url: deferred.promise,
    create: fake,
  })

  const inc = queued.client.ns.increment()
  deferred.resolve("http://ready")
  await expect(inc).resolves.toBe(1)
  await expect(queued.client.ns.increment()).resolves.toBe(2)
})

test("rejects queued calls when the URL fails; connected still settles", async () => {
  const deferred = Promise.withResolvers<string>()
  const queued = createQueuedClient<Fake>({
    url: deferred.promise,
    create: fake,
  })

  const call = queued.client.ns.method("a")
  deferred.reject(new Error("server boot failed"))
  await expect(call).rejects.toThrow("server boot failed")
  expect(queued.connected()).toBe(true)
})
