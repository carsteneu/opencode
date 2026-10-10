import { expect, test } from "bun:test"
import { createQueuedClient } from "../src/context/sdk-queued"

test("retarget points later calls at a newly discovered server", async () => {
  const seen: string[] = []
  const sdk = createQueuedClient({
    url: "http://first",
    create: (baseUrl) => ({ hit: () => seen.push(baseUrl) }),
  })

  await sdk.client.hit()
  expect(seen).toEqual(["http://first"])

  sdk.retarget("http://second")
  await sdk.client.hit()
  expect(seen).toEqual(["http://first", "http://second"])

  // A retargeted client is not `undefined`-ish: the fresh SDK is built lazily on
  // the next call, not left as a half-initialised stub.
  await sdk.client.hit()
  expect(seen).toEqual(["http://first", "http://second", "http://second"])
})
