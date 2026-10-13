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
