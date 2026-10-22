import { expect, test } from "bun:test"
import {
  MAX_INLINE_SESSION_IMAGE_PIXELS,
  inlineImageBudgetExceeded,
  probeSessionImage,
  sessionImagePreviewHeight,
} from "../../src/util/session-image-preview"
import { sizedImage } from "../fixture/sized-image"

test("allows exactly the inline pixel budget", () => {
  expect(MAX_INLINE_SESSION_IMAGE_PIXELS).toBe(4 * 1024 * 1024)
  expect(inlineImageBudgetExceeded(sizedImage(2048, 2048))).toBe(false)
})

test("rejects a single pixel above the inline pixel budget", () => {
  expect(inlineImageBudgetExceeded(sizedImage(2049, 2048))).toBe(true)
  expect(inlineImageBudgetExceeded(sizedImage(3000, 3000))).toBe(true)
})

test("leaves uninspectable sources to the decoder", () => {
  expect(inlineImageBudgetExceeded("https://example.com/huge.png")).toBe(false)
  expect(inlineImageBudgetExceeded("data:image/png;base64,AQID")).toBe(false)
})

test("still enforces the budget when the metadata carries extra parameters", () => {
  const payload = sizedImage(3000, 3000).slice("data:image/png;base64,".length)
  const small = sizedImage(96, 48).slice("data:image/png;base64,".length)
  expect(inlineImageBudgetExceeded(`data:image/png;charset=utf-8;base64,${payload}`)).toBe(true)
  expect(inlineImageBudgetExceeded(`data:image/png;charset=utf-8;base64,${small}`)).toBe(false)
})

test("refuses data image encodings it cannot probe", () => {
  expect(inlineImageBudgetExceeded("data:image/png,%89PNG%0D%0A")).toBe(true)
  expect(inlineImageBudgetExceeded("data:image/svg+xml,<svg/>")).toBe(true)
})

test("rejects a payload longer than any within-budget image could encode to", () => {
  expect(inlineImageBudgetExceeded(`data:image/png;base64,${"A".repeat(33 * 1024 * 1024)}`)).toBe(true)
})

test("measures an inline image once, for both the aspect ratio and the budget", () => {
  expect(probeSessionImage(sizedImage(96, 48))).toEqual({ status: "measured", width: 96, height: 48 })
  expect(probeSessionImage(sizedImage(2048, 2048))).toEqual({ status: "measured", width: 2048, height: 2048 })
})

test("reports a source without a readable header as unmeasured", () => {
  expect(probeSessionImage("data:image/png;base64,AQID")).toEqual({ status: "unmeasured" })
  expect(probeSessionImage("https://example.com/sun.png")).toEqual({ status: "unmeasured" })
})

test("reports an unprobeable data image and a budget overrun as oversized", () => {
  expect(probeSessionImage("data:image/png,%89PNG%0D%0A")).toEqual({ status: "oversized" })
  expect(probeSessionImage(sizedImage(3000, 3000))).toEqual({ status: "oversized" })
})

test("sizes a preview from its aspect ratio and the width it was given", () => {
  expect(sessionImagePreviewHeight(24, 80)).toBe(23)
  expect(sessionImagePreviewHeight(40, 120, 1, 1, 2)).toBe(60)
  // The row takes the height its full width demands; a tall preview is stacked in bands, not narrowed.
  expect(sessionImagePreviewHeight(24, 80, 1, 10, 2)).toBe(400)
  expect(sessionImagePreviewHeight(3, 10)).toBe(3)
})
