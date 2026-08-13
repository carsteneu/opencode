import { describe, expect, test } from "bun:test"
import {
  isPublicImageAddress,
  loadSessionImageSource,
  sessionImageIdentity,
  validSessionImageUri,
} from "../../src/util/session-image-load"

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("session image loading", () => {
  test("accepts bounded images without changing signed URL bytes", () => {
    const signed = "https://v3b.fal.media/files/image.png?token=abc!();:#preview"
    expect(validSessionImageUri(signed)).toBe(signed)
    expect(validSessionImageUri(" data:image/png;base64,aGVsbG8= ")).toBeUndefined()
    expect(validSessionImageUri(`data:image/png;base64,${"a".repeat(8 * 1024 * 1024)}`)).toBeUndefined()
  })

  test("uses compact identities for inline image data", () => {
    const uri = `data:image/png;base64,${"a".repeat(1024)}`
    const identity = sessionImageIdentity(uri)
    expect(identity.length).toBeLessThan(200)
    expect(identity).not.toContain("a".repeat(256))
  })

  test("rejects private, special, mapped, and documentation addresses", () => {
    ;[
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "198.18.0.1",
      "203.0.113.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:127.0.0.1",
      "::ffff:0:169.254.169.254",
      "64:ff9b::7f00:1",
      "2001:db8::1",
      "2002:7f00:1::",
      "fc00::1",
      "fec0::1",
      "fe80::1",
      "ff02::1",
    ].forEach((address) => expect(isPublicImageAddress(address), address).toBe(false))
  })

  test("accepts globally routable IPv4 and IPv6 addresses", () => {
    expect(isPublicImageAddress("1.1.1.1")).toBe(true)
    expect(isPublicImageAddress("2606:4700:4700::1111")).toBe(true)
    expect(isPublicImageAddress("::ffff:1.1.1.1")).toBe(true)
  })

  test("blocks direct private HTTPS targets before connecting", async () => {
    expect(validSessionImageUri("https://127.0.0.1/secret.png")).toBeUndefined()
    expect(validSessionImageUri("https://[::1]/secret.png")).toBeUndefined()
    const error = await loadSessionImageSource("https://169.254.169.254/latest/meta-data").then(
      () => undefined,
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty("message", "Invalid image source")
  })

  test("decodes a bounded inline image to bytes", async () => {
    expect(await loadSessionImageSource("data:image/png;base64,aGVsbG8=")).toEqual(Buffer.from("hello"))
  })

  test("enforces the decoded pixel limit before creating an inline preview", async () => {
    expect(await loadSessionImageSource(pixel, undefined, 1)).toBeInstanceOf(Uint8Array)
    const error = await loadSessionImageSource(pixel, undefined, 0).then(
      () => undefined,
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty("message", "Image is too large for an inline preview")
  })
})
