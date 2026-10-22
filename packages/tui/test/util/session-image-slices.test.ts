import { describe, expect, test } from "bun:test"
import { pixelBands, sliceRows } from "../../src/util/session-image-slices"

describe("sliceRows", () => {
  test("splits into bands no taller than the cap", () => {
    expect(sliceRows(142, 15)).toEqual([15, 15, 15, 15, 15, 15, 15, 15, 15, 7])
  })

  test("keeps a short preview as one band", () => {
    expect(sliceRows(9, 15)).toEqual([9])
  })

  test("never returns an empty band", () => {
    expect(sliceRows(0, 15)).toEqual([])
    // A cap below one row is still one row, so nothing is dropped.
    expect(sliceRows(5, 0)).toEqual([1, 1, 1, 1, 1])
  })
})

describe("pixelBands", () => {
  test("covers the whole image without gaps or overlap", () => {
    const rows = sliceRows(142, 15)
    const bands = pixelBands(900, rows)
    expect(bands[0]!.top).toBe(0)
    expect(bands.at(-1)!.top + bands.at(-1)!.height).toBe(900)
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index]!.top).toBe(bands[index - 1]!.top + bands[index - 1]!.height)
    }
  })

  test("gives each band its share of the rows", () => {
    const bands = pixelBands(300, [1, 1, 1])
    expect(bands).toEqual([
      { top: 0, height: 100 },
      { top: 100, height: 100 },
      { top: 200, height: 100 },
    ])
  })
})
