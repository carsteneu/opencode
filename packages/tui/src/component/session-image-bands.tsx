/** @jsxImportSource @opentui/solid */
import { NativeImage } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js"
import { pixelBands, sliceRows } from "../util/session-image-slices"

type Band = { source: NativeImage | string; rows: number }

/**
 * Draws a preview as a stack of image bands. One renderable cannot exceed the renderer's paint limit, so a
 * tall preview is split; each band is stretched to the full width and to its share of the rows, which keeps
 * the whole image at full width and at its true aspect ratio.
 *
 * The first band is drawn from the source itself, so a preview exists on the first frame; the sliced bands
 * replace it once the image is decoded.
 *
 * Native images are owned here, not by the renderables: they are released after the frame that stopped
 * showing them (a band disposed while still mounted leaves the renderer with a dead handle) and once more on
 * unmount, tolerantly, because a renderer that is already gone refuses the call.
 */
export function SessionImageBands(props: {
  source: string
  rows: number
  maxBandRows: number
  onError: () => void
}) {
  const renderer = useRenderer()
  const owner = createMemo(
    () => (renderer as unknown as { nativeScene?: { resourceContext?: unknown } }).nativeScene?.resourceContext,
  )
  const fallback = createMemo<Band[]>(() => [
    { source: props.source, rows: Math.max(1, Math.min(props.rows, Math.max(1, props.maxBandRows))) },
  ])
  const [sliced, setSliced] = createSignal<Band[] | undefined>()
  const bands = createMemo(() => sliced() ?? fallback())

  const owned = new Set<NativeImage>()
  let generation = 0

  const release = (image: NativeImage) => {
    owned.delete(image)
    try {
      image.dispose()
    } catch {}
  }
  const releaseAfterFrame = (list: readonly Band[]) => {
    setTimeout(() => {
      for (const band of list) if (typeof band.source !== "string") release(band.source)
    }, 0)
  }

  createEffect(() => {
    const source = props.source
    const rows = props.rows
    const cap = Math.max(1, props.maxBandRows)
    const context = owner()
    // Nothing to split: a single band is already the whole preview.
    if (!context || rows <= cap) {
      setSliced(undefined)
      return
    }

    const current = ++generation
    void (async () => {
      try {
        const full = await NativeImage.load(source, { owner: context } as never)
        if (current !== generation) {
          release(full)
          return
        }
        const counts = sliceRows(rows, cap)
        const created = pixelBands(full.height, counts).map((band, index) => {
          const source = full.extract({
            left: 0,
            top: band.top,
            width: full.width,
            height: band.height,
          } as never)
          owned.add(source)
          return { source, rows: counts[index]! }
        })
        release(full)
        const previous = sliced()
        setSliced(created)
        if (previous) releaseAfterFrame(previous)
      } catch {
        if (current === generation) props.onError()
      }
    })()
  })

  onCleanup(() => {
    generation += 1
    for (const image of [...owned]) release(image)
  })

  return (
    <For each={bands()}>
      {(band) => (
        <image source={band.source} fit="fill" protocol="auto" width="100%" height={band.rows} />
      )}
    </For>
  )
}
