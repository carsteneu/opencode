import { getComponentCatalogue, Dynamic, type JSX } from "@opentui/solid"
import type { ImageSource } from "@opentui/core"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { loadSessionImageSource } from "../util/session-image-load"

const nativeImageComponent = "image" as keyof JSX.IntrinsicElements & string
let activeImage: { release: () => void } | undefined

export function SessionNativeImage(props: {
  source: string
  fit: "fit" | "cover"
  protocol: "auto"
  width: number | string
  height: number | string
  onError?: (error: unknown) => void
}) {
  const [source, setSource] = createSignal<ImageSource>()

  createEffect(() => {
    const controller = new AbortController()
    const lease = {
      release: () => {
        controller.abort()
        setSource(undefined)
      },
    }
    activeImage?.release()
    activeImage = lease

    void loadSessionImageSource(props.source, controller.signal).then(
      (result) => {
        if (controller.signal.aborted || activeImage !== lease) return
        setSource(result)
      },
      (error) => {
        if (controller.signal.aborted || activeImage !== lease) return
        activeImage = undefined
        setSource(undefined)
        props.onError?.(error)
      },
    )

    onCleanup(() => {
      lease.release()
      if (activeImage === lease) activeImage = undefined
    })
  })

  return (
    <Show when={source()}>
      {(image) => (
        <Dynamic
          component={nativeImageComponent}
          source={image()}
          fit={props.fit}
          protocol={props.protocol}
          width={props.width}
          height={props.height}
          onError={props.onError}
        />
      )}
    </Show>
  )
}

export function supportsNativeImages() {
  return "image" in getComponentCatalogue()
}
