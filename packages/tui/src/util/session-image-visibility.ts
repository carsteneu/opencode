/**
 * Whether a preview row is close enough to the viewport to justify holding a decoded image.
 *
 * Hysteresis is the point: a row keeps its image while it stays within the wide margin and only asks for
 * one back once it is inside the narrow one, so scrolling over the boundary does not decode and free the
 * same image on every frame. The row itself keeps its height either way; only the image goes.
 */
export const VIEWPORT_ENTER_SCREENS = 1
export const VIEWPORT_LEAVE_SCREENS = 2

/** A row intersects the viewport when it overlaps `[-margin, viewportHeight + margin]`. */
export function intersectsViewport(top: number, height: number, viewportHeight: number, margin: number) {
  if (viewportHeight <= 0) return false
  return top + Math.max(0, height) >= -margin && top <= viewportHeight + margin
}

/** The margin a row gets this frame: wide while it holds an image, narrow while it does not. */
export function visibilityMargin(shown: boolean, viewportHeight: number) {
  return Math.max(0, viewportHeight) * (shown ? VIEWPORT_LEAVE_SCREENS : VIEWPORT_ENTER_SCREENS)
}
