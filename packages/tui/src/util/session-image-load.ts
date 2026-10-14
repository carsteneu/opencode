import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { isIP } from "node:net"
import { sniffImageMime } from "./session-image-file"

// Ported from the v1 TUI (packages/tui/src/util/session-image-load.ts), same constants and same
// guards. The one deliberate change is the return value: v1 handed back raw bytes and applied the
// pixel budget itself, while the v2 transcript render path takes a preview source and applies the
// 4 Mi px budget in probeSessionImage, so this module returns a data URL and leaves the budget to
// that single implementation.

const dataImagePrefix = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i
const dataImagePayload = /^[a-z0-9+/]+={0,2}$/i
const supportedContentType = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const maxDataUriLength = 8 * 1024 * 1024
const maxRemoteUriLength = 8192
const maxRemoteImageBytes = 16 * 1024 * 1024
const maxRedirects = 3
const requestTimeout = 15_000
const maxHeaderBytes = 16 * 1024
const blockedIpv6: readonly (readonly [network: string, prefix: number])[] = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
]

export function validSessionImageUri(value: string): string | undefined {
  if (value !== value.trim()) return undefined
  if (dataImagePrefix.test(value)) {
    if (value.length > maxDataUriLength) return undefined
    const payload = value.slice(value.indexOf(",") + 1)
    if (payload.length % 4 === 1 || !dataImagePayload.test(payload)) return undefined
    return value
  }
  if (value.length > maxRemoteUriLength) return undefined
  const url = URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password) return undefined
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(hostname) > 0 && !isPublicImageAddress(hostname)) return undefined
  return value
}

export function isSessionDataImageUri(value: string) {
  return dataImagePrefix.test(value)
}

export function sessionImageIdentity(value: string) {
  if (!isSessionDataImageUri(value)) return value
  return `data:${value.length}:${value.slice(0, 64)}:${value.slice(-64)}`
}

/**
 * The address to connect to, or nothing when the host may not be used. Every address the host
 * resolves to is checked, not just the one that would be chosen: a host that answers with both a
 * public and a private address must not be reachable through the private one.
 */
export function publicImageAddress(addresses: readonly LookupAddress[], family?: number) {
  if (addresses.length === 0) return undefined
  if (addresses.some((address) => !isPublicImageAddress(address.address))) return undefined
  return addresses.find((address) => !family || address.family === family)
}

/**
 * The next hop of an image redirect, or nothing when it must not be followed: the budget is spent,
 * the location is unreadable, or the hop fails exactly the validation the first URL passed. A
 * redirect therefore cannot downgrade the scheme or reach an address the first URL could not.
 */
export function imageRedirect(location: string | string[] | undefined, base: URL, redirects: number) {
  if (redirects >= maxRedirects) return undefined
  const value = Array.isArray(location) ? location[0] : location
  if (!value) return undefined
  const next = URL.parse(value, base)
  if (!next) return undefined
  const uri = validSessionImageUri(next.href)
  if (!uri || isSessionDataImageUri(uri)) return undefined
  return next
}

export type LookupAddress = { address: string; family: number }

export type ImageResponse = {
  statusCode?: number
  headers: Record<string, string | string[] | undefined>
  destroy(error?: Error): unknown
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  on(event: "end", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
}

/**
 * The body of an accepted image response, with the response's own policy applied first: only 2xx,
 * only an allowlisted image type, only an identity encoding, and a declared length that fits. The
 * byte cap is then enforced again while the body streams, because the header is only a claim.
 */
export function collectImageBytes(response: ImageResponse, signal?: AbortSignal) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      response.destroy()
      reject(new Error(`Image request failed with HTTP ${status}`))
      return
    }
    const contentType = (header(response, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (!supportedContentType.has(contentType)) {
      response.destroy()
      reject(new Error("Image response has an unsupported content type"))
      return
    }
    const contentEncoding = (header(response, "content-encoding") ?? "").trim().toLowerCase()
    if (contentEncoding && contentEncoding !== "identity") {
      response.destroy()
      reject(new Error("Image response uses unsupported content encoding"))
      return
    }
    const contentLength = Number(header(response, "content-length") ?? 0)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxRemoteImageBytes) {
      response.destroy()
      reject(new Error("Image response is too large"))
      return
    }

    let settled = false
    const finish = (result: Uint8Array | Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    // Settling on abort as well as destroying the response: v1 relied on the socket error that
    // destroy() produces, which leaves this promise pending when the response never reports one.
    const abort = () => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error("Image load aborted")
      response.destroy(reason)
      finish(reason)
    }

    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }

    let data = new Uint8Array(contentLength || 64 * 1024)
    let total = 0
    response.on("data", (chunk: Uint8Array) => {
      const next = total + chunk.byteLength
      if (next > maxRemoteImageBytes) {
        const error = new Error("Image response is too large")
        finish(error)
        response.destroy(error)
        return
      }
      if (next > data.byteLength) {
        const expanded = new Uint8Array(Math.min(maxRemoteImageBytes, Math.max(next, data.byteLength * 2)))
        expanded.set(data.subarray(0, total))
        data = expanded
      }
      data.set(chunk, total)
      total = next
    })
    response.on("error", finish)
    response.on("end", () => {
      if (total > maxRemoteImageBytes) {
        finish(new Error("Image response is too large"))
        return
      }
      finish(total === data.byteLength ? data : data.subarray(0, total))
    })
  })
}

/** A validated source as a data URL: the remote bytes are fetched under the guards above, then encoded. */
export async function loadSessionImageSource(value: string, signal?: AbortSignal): Promise<string> {
  const uri = validSessionImageUri(value)
  if (!uri) throw new Error("Invalid image source")
  signal?.throwIfAborted()
  if (isSessionDataImageUri(uri)) return uri
  const { bytes, mime } = await loadRemoteImage(
    URL.parse(uri)!,
    signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout),
    0,
  )
  signal?.throwIfAborted()
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

export function isPublicImageAddress(value: string) {
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(ipv4Value(address)!)
  if (family !== 6) return false

  const parsed = ipv6Value(address)!
  if (parsed >> 32n === 0xffffn) return isPublicIpv4(Number(parsed & 0xffffffffn))
  if (parsed >> 32n === 0xffff0000n) return false
  return !blockedIpv6.some(([network, prefix]) => inIpv6Subnet(parsed, network, prefix))
}

async function loadRemoteImage(
  url: URL,
  signal: AbortSignal | undefined,
  redirects: number,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (redirects > maxRedirects) throw new Error("Too many image redirects")
  const uri = validSessionImageUri(url.href)
  if (!uri || isSessionDataImageUri(uri)) throw new Error("Invalid remote image source")

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { bytes: Uint8Array; mime: string } | Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (result instanceof Error) {
        reject(result)
        return
      }
      resolve(result)
    }
    const req = request(url, {
      // No shared agent: a pooled socket could be reused for a later request to a different host.
      agent: false,
      headers: {
        accept: "image/png,image/jpeg,image/webp,image/gif",
        "accept-encoding": "identity",
        "user-agent": "opencode-image-preview",
      },
      lookup: (hostname, options, callback) => {
        const all = typeof options === "object" && options.all
        // Node also accepts the literal names "IPv4"/"IPv6" in this field; any family we hand on was
        // already checked, so an unusable name is not a reason to fail the request.
        const family =
          typeof options === "number" ? options : typeof options.family === "number" ? options.family : undefined
        const fail = (error: Error) => (all ? callback(error, []) : callback(error, "", 4))
        void lookup(hostname, { all: true, verbatim: true }).then(
          (addresses) => {
            const address = publicImageAddress(addresses, all ? undefined : family)
            if (!address) {
              fail(new Error("Image host does not resolve to a public address"))
              return
            }
            if (all) {
              callback(null, addresses)
              return
            }
            callback(null, address.address, address.family)
          },
          (error: Error) => fail(error),
        )
      },
      maxHeaderSize: maxHeaderBytes,
    })
    const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Image load aborted"))

    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    req.setTimeout(requestTimeout, () => req.destroy(new Error("Image request timed out")))
    req.on("error", finish)
    req.on("response", (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.destroy()
        const redirect = imageRedirect(response.headers.location, url, redirects)
        if (!redirect) {
          finish(new Error("Invalid image redirect"))
          return
        }
        void loadRemoteImage(redirect, signal, redirects + 1).then(finish, finish)
        return
      }
      const declared = (header(response, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
      collectImageBytes(response, signal).then(
        (bytes) => finish({ bytes, mime: sniffImageMime(bytes) ?? declared }),
        (error: Error) => {
          response.destroy()
          finish(error)
        },
      )
    })
    req.end()
  })
}

function header(response: ImageResponse, name: string) {
  const value = response.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isPublicIpv4(value: number) {
  const first = value >>> 24
  const second = (value >>> 16) & 0xff
  const third = (value >>> 8) & 0xff
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && second === 0 && third === 0) return false
  if (first === 192 && second === 0 && third === 2) return false
  if (first === 192 && second === 88 && third === 99) return false
  if (first === 192 && second === 168) return false
  if (first === 198 && (second === 18 || second === 19)) return false
  if (first === 198 && second === 51 && third === 100) return false
  if (first === 203 && second === 0 && third === 113) return false
  return true
}

function ipv4Value(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined
  return value.split(".").reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0)
}

function ipv6Value(value: string): bigint | undefined {
  const address = value.split("%", 1)[0]!.toLowerCase()
  if (isIP(address) !== 6) return undefined
  const dotted = address.lastIndexOf(":")
  const normalized = address.slice(dotted + 1).includes(".")
    ? `${address.slice(0, dotted)}:${(ipv4Value(address.slice(dotted + 1))! >>> 16).toString(16)}:${(
        ipv4Value(address.slice(dotted + 1))! & 0xffff
      ).toString(16)}`
    : address
  const halves = normalized.split("::")
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves[1] ? halves[1].split(":") : []
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
  if (groups.length !== 8) return undefined
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
}

function inIpv6Subnet(value: bigint, network: string, prefix: number) {
  const shift = BigInt(128 - prefix)
  return value >> shift === ipv6Value(network)! >> shift
}
