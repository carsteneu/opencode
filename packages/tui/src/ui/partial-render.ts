import { onCleanup, createEffect } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useDialog } from "./dialog"
import type { Renderable } from "@opentui/core"

/**
 * Opt a renderable into the renderer's partial-render fast path.
 *
 * When enabled, `requestRender()` calls from this renderable land in
 * `CliRenderer.requestPartialRender` instead of triggering a full tree walk.
 * The renderer may then draw only this renderable into the persistent frame
 * buffer and skip the rest, cutting CPU on per-frame animation ticks (e.g. the
 * spinner).
 *
 * App-level gate: while any dialog is mounted (dialog.stack.length > 0), the
 * partial path is disabled for this renderable. This prevents stale-overlap
 * artifacts when an overlay covers the spinner region or changes z-order.
 *
 * Call this from a component body with an accessor that returns the mounted
 * renderable (or undefined before mount). The effect reconciles eligibility
 * across mount/unmount and dialog open/close.
 *
 * Safe no-op when the renderer does not expose requestPartialRender (older
 * @opentui/core builds) — the renderable just falls back to full renders.
 */
export function usePartialRender(getRenderable: () => Renderable | undefined | null): void {
  const renderer = useRenderer() as unknown as {
    requestPartialRender?: (renderable: Renderable) => void
  }
  const dialog = useDialog()

  // Renderer too old to support the partial API → nothing to do.
  if (typeof renderer.requestPartialRender !== "function") return

  let current: Renderable | undefined | null = null

  const apply = (on: boolean) => {
    if (current && !current.isDestroyed) {
      current.setPartialEligible(on)
    }
  }

  createEffect(() => {
    const renderable = getRenderable()
    const dialogOpen = dialog.stack.length > 0

    // Turn the previous renderable off before binding a new one.
    if (current && current !== renderable) {
      apply(false)
    }
    current = renderable

    // Partial eligibility requires: a live renderable AND no dialog mounted.
    apply(!!renderable && !dialogOpen)
  })

  onCleanup(() => {
    apply(false)
    current = null
  })
}
