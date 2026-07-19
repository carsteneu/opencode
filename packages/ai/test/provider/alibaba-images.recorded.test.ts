import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Image } from "../../src"
import { Alibaba } from "../../src/providers"
import { recordedTests } from "../recorded-test"

const alibaba = Alibaba.configure({
  apiKey: process.env.DASHSCOPE_API_KEY ?? "fixture",
})

const recorded = recordedTests({
  prefix: "alibaba-images",
  provider: "alibaba",
  protocol: "alibaba-images",
  requires: ["DASHSCOPE_API_KEY"],
})

describe("Alibaba Images recorded", () => {
  recorded.effect("generates with Qwen Image 2.0", () =>
    Effect.gen(function* () {
      const response = yield* Image.generate({
        model: alibaba.image("qwen-image-2.0"),
        prompt: "A simple flat black circle centered on a plain white background.",
        size: { width: 512, height: 512 },
        providerOptions: { alibaba: { qwen: { promptExtend: false, watermark: false } } },
      })

      expect(response.images).toHaveLength(1)
      expect(response.image?.mediaType).toBe("image/png")
      expect(response.image?.data).toStartWith("https://")
    }),
  )

  recorded.effect("generates with Wan 2.7", () =>
    Effect.gen(function* () {
      const response = yield* Image.generate({
        model: alibaba.image("wan2.7-image"),
        prompt: "A simple flat black square centered on a plain white background.",
        providerOptions: { alibaba: { wan: { resolution: "1K", thinkingMode: false, watermark: false } } },
      })

      expect(response.images).toHaveLength(1)
      expect(response.image?.mediaType).toBe("image/png")
      expect(response.image?.data).toStartWith("https://")
    }),
  )
})
