import { ForkRelease } from "@opencode/util/installation/fork-release"
import { createHash } from "node:crypto"

/** The contract only covers the platforms the fork publishes, so tests skip elsewhere. */
export const supported = ForkRelease.asset() !== undefined

export const binaryAsset = ForkRelease.asset()!

const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex")

/** Runs standalone and reports a version, like the real release asset does. */
export const executable = (version: string) => `#!/bin/sh\necho "opencode v${version}"\n`

export type Release = {
  readonly tag: string
  /** Asset bytes; a file is streamed from disk instead of buffered. */
  readonly binary?: string | { readonly file: string }
  /** Overrides the published checksum sidecar. */
  readonly checksum?: string
  readonly draft?: boolean
  readonly prerelease?: boolean
  /** Publishes the binary without its checksum sidecar. */
  readonly omitChecksum?: boolean
}

/** Serves the asset body only in part so the download fails mid-stream. */
export type Fault = "truncate-binary" | "truncate-checksum"

export type Fixture = {
  readonly url: string
  readonly requests: ReadonlyArray<string>
  readonly close: () => void
}

/**
 * A GitHub-shaped fixture channel: the release listing and the assets, served
 * over HTTP so the updater walks its real network path without publishing
 * anything. `OPENCODE_FORK_RELEASE_SOURCE` points the contract at it.
 */
export async function serve(releases: ReadonlyArray<Release>, faults: ReadonlyArray<Fault> = []): Promise<Fixture> {
  const bodies = new Map<string, string | { readonly file: string }>()
  const listing = await Promise.all(
    releases.map(async (release) => {
      const version = ForkRelease.version(release.tag) ?? release.tag
      const body = release.binary ?? executable(version)
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(await Bun.file(body.file).arrayBuffer())
      bodies.set(`${version}/${binaryAsset}`, body)
      bodies.set(
        `${version}/${ForkRelease.checksumAsset(binaryAsset)}`,
        release.checksum ?? ForkRelease.checksumFile(digest(bytes), binaryAsset),
      )
      return {
        version,
        tag_name: release.tag,
        draft: release.draft ?? false,
        prerelease: release.prerelease ?? true,
        assets: [
          { name: binaryAsset },
          ...(release.omitChecksum ? [] : [{ name: ForkRelease.checksumAsset(binaryAsset) }]),
        ],
      }
    }),
  )
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === `/repos/${ForkRelease.repository}/releases`) {
        return Response.json(
          listing.map(({ version, ...release }) => ({
            ...release,
            assets: release.assets.map((asset) => ({
              ...asset,
              browser_download_url: `${url.origin}/assets/${version}/${asset.name}`,
            })),
          })),
        )
      }
      const [version, name] = url.pathname.replace(/^\/assets\//, "").split("/")
      const body = bodies.get(`${version}/${name}`)
      if (body === undefined) return new Response("not found", { status: 404 })
      const truncated = name === binaryAsset ? faults.includes("truncate-binary") : faults.includes("truncate-checksum")
      if (truncated) {
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))))
              controller.error(new Error("connection reset during download"))
            },
          }),
        )
      }
      if (typeof body === "object") return new Response(Bun.file(body.file))
      return new Response(body)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: () => void server.stop(true),
  }
}
