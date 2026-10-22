/** @jsxImportSource @opentui/solid */
import { NativeImage } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup } from "solid-js"
import { pixelBands, sliceRows } from "../util/session-image-slices"

type Band = { source: NativeImage; rows: number }

/**
 * Draws a preview as a stack of image bands. One renderable cannot exceed the renderer's paint limit, so a
 * tall preview is split; each band is stretched to the full width and to its share of the rows, which keeps
 * the whole image at full width and at its true aspect ratio.
 */
export function SessionImageBands(props: {
  source: string
  rows: number
  maxBandRows: number
  onError: () => void
}) {
  const renderer = useRenderer()
  const [bands, setBands] = createSignal<Band[]>([])
  let generation = 0

  const dispose = (list: readonly Band[]) => {
    for (const band of list) band.source.dispose()
  }

  createEffect(() => {
    const source = props.source
    const rows = props.rows
    const cap = Math.max(1, props.maxBandRows)
    const owner = (renderer as unknown as { nativeScene?: { resourceContext?: unknown } }).nativeScene
      ?.resourceContext
    if (!owner || rows <= 0) return

    const current = ++generation
    void (async () => {
      try {
        const full = await NativeImage.load(source, { owner } as never)
        if (current !== generation) {
          full.dispose()
          return
        }
        const counts = sliceRows(rows, cap)
        const created = pixelBands(full.height, counts).map((band, index) => ({
          source: full.extract({ left: 0, top: band.top, width: full.width, height: band.height } as never),
          rows: counts[index]!,
        }))
        full.dispose()
        const previous = bands()
        setBands(created)
        dispose(previous)
      } catch {
        if (current === generation) props.onError()
      }
    })()
  })

  onCleanup(() => {
    generation += 1
    dispose(bands())
  })

  return (
    <For each={bands()}>
      {(band) => (
        <image source={band.source} fit="fill" protocol="auto" width="100%" height={band.rows} />
      )}
    </For>
  )
}
