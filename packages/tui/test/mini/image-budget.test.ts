import { expect, test } from "bun:test"
import { MAX_INLINE_SESSION_IMAGE_PIXELS, inlineImageBudgetExceeded } from "../../src/mini/image-budget"
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
