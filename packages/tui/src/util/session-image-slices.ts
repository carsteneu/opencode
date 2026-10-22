/**
 * A preview taller than the renderer's paint limit is invisible: 0.6.6 draws no cell of a renderable whose
 * row height exceeds roughly twice the viewport, so a portrait image would either narrow itself to fit the
 * cap or disappear. Stacking the image in bands keeps every renderable short enough to paint, which lets the
 * preview take the full transcript width and be as tall as its aspect ratio demands.
 */

/** Row counts for the stack, none above `maxSliceRows`. */
export function sliceRows(totalRows: number, maxSliceRows: number) {
  const rows: number[] = []
  let remaining = Math.max(0, Math.round(totalRows))
  const cap = Math.max(1, Math.round(maxSliceRows))
  while (remaining > 0) {
    const take = Math.min(remaining, cap)
    rows.push(take)
    remaining -= take
  }
  return rows
}

/** Pixel band per slice, proportional to its row share, so the stack reproduces the whole image. */
export function pixelBands(pixelHeight: number, rows: readonly number[]) {
  const total = rows.reduce((sum, row) => sum + row, 0)
  const bands: { top: number; height: number }[] = []
  let consumed = 0
  let top = 0
  for (const row of rows) {
    consumed += row
    const bottom = total === 0 ? top : Math.round((consumed / total) * pixelHeight)
    bands.push({ top, height: Math.max(1, bottom - top) })
    top = bottom
  }
  return bands
}
