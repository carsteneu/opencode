import { getComponentCatalogue, Dynamic, type JSX } from "@opentui/solid"
import { imageInfo, type NativeImage } from "@opentui/core"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { loadSessionImageSource } from "../util/session-image-load"
import type {
  SessionImageSource,
  SessionImageSourceAcquirer,
  SessionImageSourceLease,
} from "../util/session-image-source"

const nativeImageComponent = "image" as keyof JSX.IntrinsicElements & string

type HeldSource = {
  uri: string
  lease: SessionImageSourceLease
  released: boolean
}

export function SessionNativeImage(props: {
  source?: string
  load?: SessionImageSourceAcquirer
  fit: "fit" | "cover"
  protocol: "auto"
  width: number | string
  height: number | string
  maxPixels?: number
  onSource?: (source: SessionImageSource | undefined) => void
  onLoad?: (image: NativeImage) => void
  onError?: (error: unknown) => void
  onRelease?: () => void
}) {
  const [rendered, setRendered] = createSignal<HeldSource>()
  let committed: HeldSource | undefined
  let candidate: HeldSource | undefined

  const release = (source: HeldSource | undefined) => {
    if (!source || source.released) return
    source.released = true
    source.lease.release()
  }

  const deactivate = () => {
    const current = committed
    const pending = candidate
    committed = undefined
    candidate = undefined
    setRendered(undefined)
    props.onSource?.(undefined)
    release(pending)
    release(current)
    if (current) props.onRelease?.()
  }

  const loaded = (image: NativeImage) => {
    const next = candidate
    if (!next) return
    const previous = committed
    candidate = undefined
    committed = next
    release(previous)
    props.onLoad?.(image)
  }

  const failed = (error: unknown) => {
    const current = candidate
    if (!current) {
      const previous = committed
      committed = undefined
      setRendered(undefined)
      props.onSource?.(undefined)
      release(previous)
      if (previous) props.onRelease?.()
      props.onError?.(error)
      return
    }
    candidate = undefined
    setRendered(committed)
    props.onSource?.(undefined)
    release(current)
    props.onError?.(error)
  }

  createEffect(() => {
    const uri = props.source
    if (!uri) {
      deactivate()
      return
    }

    const controller = new AbortController()
    let acquired: HeldSource | undefined
    if (committed?.uri !== uri) props.onSource?.(undefined)
    void (props.load ?? acquireSessionImageSource)(uri, controller.signal, props.maxPixels).then(
      (lease) => {
        if (controller.signal.aborted) {
          lease.release()
          return
        }
        acquired = { uri, lease, released: false }
        candidate = acquired
        props.onSource?.(lease.source)
        setRendered(acquired)
      },
      (error) => {
        if (controller.signal.aborted) return
        props.onError?.(error)
      },
    )

    onCleanup(() => {
      controller.abort()
      if (!acquired || acquired === committed) return
      if (candidate === acquired) candidate = undefined
      setRendered(committed)
      release(acquired)
    })
  })

  onCleanup(deactivate)

  return (
    <Show when={rendered()}>
      {(source) => (
        <Dynamic
          component={nativeImageComponent}
          source={source().lease.source.data}
          fit={props.fit}
          protocol={props.protocol}
          width={props.width}
          height={props.height}
          onLoad={loaded}
          onError={failed}
        />
      )}
    </Show>
  )
}

export function supportsNativeImages() {
  return "image" in getComponentCatalogue()
}

async function acquireSessionImageSource(value: string, signal?: AbortSignal, maxPixels?: number) {
  const data = await loadSessionImageSource(value, signal, maxPixels)
  const info = imageInfo(data)
  return {
    source: { data, width: info.width, height: info.height },
    release() {},
  }
}
