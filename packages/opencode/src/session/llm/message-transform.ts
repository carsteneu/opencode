import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import type { LanguageModelMiddleware } from "ai"

export function middleware(
  model: Provider.Model,
  options: Record<string, unknown>,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    async transformParams(args) {
      if (args.type === "stream") {
        // @ts-expect-error ProviderTransform accepts the structurally compatible V3 prompt.
        args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
      }
      return args.params
    },
  }
}

export const LLMMessageTransform = { middleware }
