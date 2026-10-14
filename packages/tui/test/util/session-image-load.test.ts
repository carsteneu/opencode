import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  collectImageBytes,
  imageRedirect,
  isPublicImageAddress,
  publicImageAddress,
  sessionImageIdentity,
  validSessionImageUri,
  type ImageResponse,
} from "../../src/util/session-image-load"
import { MAX_LOCAL_IMAGE_BYTES, localImageDataUri, sniffImageMime } from "../../src/util/session-image-file"
import { acquireImagePreview, releaseImagePreview } from "../../src/util/session-image-preview-cache"
import { sizedImage } from "../fixture/sized-image"

const PUBLIC = "https://cdn.example.com/chart.png"

describe("validSessionImageUri", () => {
  test("accepts public https and inline base64 images", () => {
    expect(validSessionImageUri(PUBLIC)).toBe(PUBLIC)
    expect(validSessionImageUri("https://cdn.example.com/a.png?x=1#f")).toBe("https://cdn.example.com/a.png?x=1#f")
    expect(validSessionImageUri("data:image/png;base64,aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=")
  })

  test.each([
    ["untrimmed", ` ${PUBLIC}`],
    ["trailing space", `${PUBLIC} `],
    ["http", "http://cdn.example.com/chart.png"],
    ["credentials in userinfo", "https://user:pw@cdn.example.com/chart.png"],
    ["bare username", "https://user@cdn.example.com/chart.png"],
    ["other scheme", "ftp://cdn.example.com/chart.png"],
    ["protocol relative", "//cdn.example.com/chart.png"],
    ["relative", "charts/one.png"],
    ["loopback ipv4", "https://127.0.0.1/chart.png"],
    ["private ipv4 10/8", "https://10.0.0.1/chart.png"],
    ["private ipv4 172.16/12", "https://172.16.0.1/chart.png"],
    ["private ipv4 192.168/16", "https://192.168.1.1/chart.png"],
    ["link local ipv4", "https://169.254.169.254/latest/meta-data"],
    ["shared address space", "https://100.64.0.1/chart.png"],
    ["multicast ipv4", "https://224.0.0.1/chart.png"],
    ["unspecified ipv4", "https://0.0.0.0/chart.png"],
    ["loopback ipv6", "https://[::1]/chart.png"],
    ["unique local ipv6", "https://[fc00::1]/chart.png"],
    ["link local ipv6", "https://[fe80::1]/chart.png"],
    ["documentation ipv6", "https://[2001:db8::1]/chart.png"],
    ["ipv4 mapped loopback", "https://[::ffff:127.0.0.1]/chart.png"],
    ["ipv4 mapped private", "https://[::ffff:10.0.0.1]/chart.png"],
    ["ipv4 translated private", "https://[64:ff9b::a00:1]/chart.png"],
    ["empty", ""],
    ["too long", `https://cdn.example.com/${"a".repeat(8192)}.png`],
    ["data uri without base64", "data:image/png,AAAA"],
    ["data uri of a refused type", "data:image/svg+xml;base64,PHN2Zz4="],
    ["data uri of a refused type (bmp)", "data:image/bmp;base64,AAAA"],
    ["data uri with a bad payload alphabet", "data:image/png;base64,AA$="],
    ["data uri with a truncated payload", "data:image/png;base64,AAAAA"],
    ["data uri over the length cap", `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`],
  ])("refuses %s", (_name, value) => {
    expect(validSessionImageUri(value)).toBeUndefined()
  })

  test("accepts a public literal ipv4 and a public literal ipv6", () => {
    expect(validSessionImageUri("https://1.1.1.1/chart.png")).toBe("https://1.1.1.1/chart.png")
    expect(validSessionImageUri("https://[2606:4700::1111]/chart.png")).toBe("https://[2606:4700::1111]/chart.png")
  })
})

describe("isPublicImageAddress", () => {
  test.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700::1111", "2001:4860:4860::8888"])(
    "treats %s as public",
    (address) => {
      expect(isPublicImageAddress(address)).toBeTrue()
    },
  )

  test.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "64:ff9b::a00:1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fec0::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-address",
    "example.com",
  ])("treats %s as non-public", (address) => {
    expect(isPublicImageAddress(address)).toBeFalse()
  })

  test("unwraps a bracketed literal", () => {
    expect(isPublicImageAddress("[1.1.1.1]")).toBeTrue()
    expect(isPublicImageAddress("[::1]")).toBeFalse()
  })
})

describe("publicImageAddress", () => {
  test("requires every resolved address to be public", () => {
    expect(publicImageAddress([{ address: "1.1.1.1", family: 4 }])).toEqual({ address: "1.1.1.1", family: 4 })
    expect(
      publicImageAddress([
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).toBeUndefined()
    expect(publicImageAddress([{ address: "2606:4700::1111", family: 6 }], 6)).toEqual({
      address: "2606:4700::1111",
      family: 6,
    })
  })

  test("refuses an empty answer and a family with no match", () => {
    expect(publicImageAddress([])).toBeUndefined()
    expect(publicImageAddress([{ address: "1.1.1.1", family: 4 }], 6)).toBeUndefined()
  })
})

describe("imageRedirect", () => {
  const base = new URL("https://cdn.example.com/chart.png")

  test("follows a public https hop, relative and absolute", () => {
    expect(imageRedirect("https://cdn.example.com/next.png", base, 0)?.href).toBe("https://cdn.example.com/next.png")
    expect(imageRedirect("/next.png", base, 0)?.href).toBe("https://cdn.example.com/next.png")
    expect(imageRedirect(["https://cdn.example.com/next.png"], base, 0)?.href).toBe("https://cdn.example.com/next.png")
    expect(imageRedirect("https://cdn.example.com/next.png", base, 2)?.href).toBe("https://cdn.example.com/next.png")
  })

  test.each([
    ["the budget is spent", "https://cdn.example.com/next.png", 3],
    ["the location is missing", undefined, 0],
    ["the location is empty", "", 0],
    ["the scheme is downgraded", "http://cdn.example.com/next.png", 0],
    ["the scheme is not web", "ftp://cdn.example.com/next.png", 0],
    ["the target is a private address", "https://10.0.0.1/next.png", 0],
    ["the target is loopback", "https://127.0.0.1/next.png", 0],
    ["the target carries credentials", "https://user:pw@cdn.example.com/next.png", 0],
    ["the target is a data uri", "data:image/png;base64,aGVsbG8=", 0],
  ])("refuses when %s", (_name, location, redirects) => {
    expect(imageRedirect(location as string | undefined, base, redirects)).toBeUndefined()
  })
})

function fakeImageResponse(input: {
  status?: number
  headers?: Record<string, string | string[] | undefined>
  chunks?: Uint8Array[]
  destroyed?: { value: boolean }
}) {
  const listeners = new Map<string, ((value: never) => void)[]>()
  const response = {
    statusCode: input.status ?? 200,
    headers: input.headers ?? { "content-type": "image/png" },
    destroy() {
      if (input.destroyed) input.destroyed.value = true
    },
    on(event: string, listener: (value: never) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return response
    },
  } as unknown as ImageResponse

  queueMicrotask(() => {
    if (input.destroyed?.value) return
    for (const chunk of input.chunks ?? []) listeners.get("data")?.forEach((listener) => listener(chunk as never))
    if (input.destroyed?.value) return
    listeners.get("end")?.forEach((listener) => listener(undefined as never))
  })
  return response
}

describe("collectImageBytes", () => {
  const bytes = new Uint8Array([1, 2, 3])

  test("collects a well formed image response", async () => {
    expect(await collectImageBytes(fakeImageResponse({ chunks: [bytes] }))).toEqual(bytes)
  })

  test("accepts a charset parameter on an allowed type", async () => {
    const response = fakeImageResponse({ headers: { "content-type": "image/png; charset=utf-8" }, chunks: [bytes] })
    expect(await collectImageBytes(response)).toEqual(bytes)
  })

  test("accepts an explicit identity encoding and a declared length within the cap", async () => {
    const response = fakeImageResponse({
      headers: { "content-type": "image/png", "content-encoding": "identity", "content-length": "3" },
      chunks: [bytes],
    })
    expect(await collectImageBytes(response)).toEqual(bytes)
  })

  test.each([
    ["a failing status", { status: 404 }],
    ["a redirect status", { status: 302 }],
    ["a non image type", { headers: { "content-type": "text/html" } }],
    ["a missing type", { headers: {} }],
    ["a gzip encoding", { headers: { "content-type": "image/png", "content-encoding": "gzip" } }],
    ["a declared length above the cap", { headers: { "content-type": "image/png", "content-length": "999999999999" } }],
    ["a non numeric declared length", { headers: { "content-type": "image/png", "content-length": "nope" } }],
  ])("rejects %s", async (_name, input) => {
    const destroyed = { value: false }
    await expect(collectImageBytes(fakeImageResponse({ chunks: [bytes], destroyed, ...input }))).rejects.toBeInstanceOf(
      Error,
    )
    expect(destroyed.value).toBeTrue()
  })

  test("rejects a body that outgrows the cap while streaming", async () => {
    const overflow = new Uint8Array(16 * 1024 * 1024 + 1)
    await expect(collectImageBytes(fakeImageResponse({ chunks: [overflow] }))).rejects.toThrow("too large")
  })

  test("rejects when the signal aborts mid flight and tears the response down", async () => {
    const controller = new AbortController()
    const destroyed = { value: false }
    const pending = collectImageBytes(fakeImageResponse({ destroyed }), controller.signal)
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
    expect(destroyed.value).toBeTrue()
  })
})

describe("sessionImageIdentity", () => {
  test("keeps a plain source verbatim and fingerprints a data uri", () => {
    expect(sessionImageIdentity(PUBLIC)).toBe(PUBLIC)
    expect(sessionImageIdentity("data:image/png;base64,aGVsbG8=")).toBe(
      "data:30:data:image/png;base64,aGVsbG8=:data:image/png;base64,aGVsbG8=",
    )
  })
})

describe("localImageDataUri", () => {
  async function withDirectory(run: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-image-load-"))
    try {
      await run(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  test("reads an image file as a data url with the sniffed type", async () => {
    await withDirectory(async (directory) => {
      const target = path.join(directory, "chart.png")
      await writeFile(target, Buffer.from(sizedImage(96, 48).split(",")[1]!, "base64"))
      const uri = await localImageDataUri(target)
      expect(uri).toStartWith("data:image/png;base64,")
      expect(Buffer.from(uri!.split(",")[1]!, "base64").length).toBeGreaterThan(0)
    })
  })

  test("refuses a non image that carries an image extension", async () => {
    await withDirectory(async (directory) => {
      const target = path.join(directory, "notes.png")
      await writeFile(target, "this is not an image")
      expect(await localImageDataUri(target)).toBeUndefined()
    })
  })

  test("refuses a file above the byte cap without reading it", async () => {
    await withDirectory(async (directory) => {
      const target = path.join(directory, "big.png")
      const header = Buffer.from(sizedImage(96, 48).split(",")[1]!, "base64")
      await writeFile(target, Buffer.concat([header, Buffer.alloc(MAX_LOCAL_IMAGE_BYTES)]))
      expect(await localImageDataUri(target)).toBeUndefined()
    })
  })

  test("refuses a missing path, a directory, and an empty file", async () => {
    await withDirectory(async (directory) => {
      expect(await localImageDataUri(path.join(directory, "absent.png"))).toBeUndefined()
      expect(await localImageDataUri(directory)).toBeUndefined()
      const empty = path.join(directory, "empty.png")
      await writeFile(empty, "")
      expect(await localImageDataUri(empty)).toBeUndefined()
    })
  })

  test("refuses an already aborted read", async () => {
    await withDirectory(async (directory) => {
      const target = path.join(directory, "chart.png")
      await writeFile(target, Buffer.from(sizedImage(96, 48).split(",")[1]!, "base64"))
      expect(await localImageDataUri(target, AbortSignal.abort())).toBeUndefined()
    })
  })
})

describe("sniffImageMime", () => {
  test.each([
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["webp", [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], "image/webp"],
  ])("identifies %s", (_name, bytes, mime) => {
    expect(sniffImageMime(new Uint8Array(bytes))).toBe(mime)
  })

  test("reports nothing for a short, empty, or unrecognized buffer", () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeUndefined()
    expect(sniffImageMime(new Uint8Array())).toBeUndefined()
    expect(sniffImageMime(new TextEncoder().encode("<svg></svg>"))).toBeUndefined()
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x46]))).toBeUndefined()
  })
})

describe("preview cache", () => {
  test("shares one load between concurrent consumers of the same source", async () => {
    const first = acquireImagePreview(PUBLIC)
    const second = acquireImagePreview(PUBLIC)
    expect(second).toBe(first)
    releaseImagePreview(PUBLIC)
    releaseImagePreview(PUBLIC)
  })

  test("keeps the result while a consumer still holds it and drops it once the last one leaves", async () => {
    const source = "file:///nonexistent/preview-cache-test.png"
    const held = acquireImagePreview(source)
    acquireImagePreview(source)
    releaseImagePreview(source)
    expect(await held).toBeUndefined()
    releaseImagePreview(source)

    const again = acquireImagePreview(source)
    expect(again).not.toBe(held)
    expect(await again).toBeUndefined()
    releaseImagePreview(source)
  })

  test("returns an inline data uri unchanged and releases it without a fetch", async () => {
    const source = "data:image/png;base64,aGVsbG8="
    expect(await acquireImagePreview(source)).toBe(source)
    releaseImagePreview(source)
  })

  test("resolves an aborted source as no preview", async () => {
    const source = "file:///nonexistent/aborted-preview.png"
    const pending = acquireImagePreview(source)
    releaseImagePreview(source)
    expect(await pending).toBeUndefined()
  })
})
