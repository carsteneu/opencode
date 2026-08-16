import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { LanguageModelMiddleware } from "ai"

export type TransformedPrompt = {
  readonly normalized: LanguageModelV3Prompt
  readonly cached: LanguageModelV3Prompt
}

export class ReplayMismatchError extends Error {}

export function middleware(
  model: Provider.Model,
  options: Record<string, unknown>,
  request?: {
    readonly capture?: (prompt: TransformedPrompt) => void
    readonly replay?: TransformedPrompt
  },
): LanguageModelMiddleware {
  let replayPrompt: LanguageModelV3Prompt | undefined
  let captured = false
  return {
    specificationVersion: "v3",
    async transformParams(args) {
      if (args.type !== "stream") return args.params
      if (replayPrompt) {
        args.params.prompt = structuredClone(replayPrompt)
        return args.params
      }

      if (request?.replay) {
        // Reapplying automatic caching would move Anthropic's final breakpoints.
        // Prove the normalized prefix first, then reuse the original cached prompt prefix verbatim.
        const normalized = ProviderTransform.message(args.params.prompt, model, options, {
          automaticCaching: false,
        }) as unknown as LanguageModelV3Prompt
        if (
          request.replay.normalized.length !== request.replay.cached.length ||
          !isPrefix(request.replay.normalized, normalized)
        ) {
          throw new ReplayMismatchError("Captured Anthropic prompt is not an exact replay prefix")
        }
        const suffix = normalized.slice(request.replay.normalized.length)
        if (
          suffix.at(0)?.role !== "assistant" ||
          suffix.at(-1)?.role !== "user" ||
          suffix.some((message) => message.role === "system") ||
          containsCacheControl(suffix)
        ) {
          throw new ReplayMismatchError("Anthropic replay suffix is not cache-safe")
        }
        replayPrompt = [...structuredClone(request.replay.cached), ...suffix]
        args.params.prompt = structuredClone(replayPrompt)
        return args.params
      }

      let normalized: LanguageModelV3Prompt | undefined
      // @ts-expect-error ProviderTransform accepts the structurally compatible V3 prompt.
      args.params.prompt = ProviderTransform.message(args.params.prompt, model, options, {
        captureNormalized(messages) {
          if (!request?.capture || captured) return
          normalized = structuredClone(messages) as unknown as LanguageModelV3Prompt
        },
      })
      if (
        request?.capture &&
        !captured &&
        normalized &&
        normalized.length === args.params.prompt.length &&
        ["user", "tool"].includes(normalized.at(-1)?.role ?? "")
      ) {
        captured = true
        request.capture({
          normalized,
          cached: structuredClone(args.params.prompt),
        })
      }
      return args.params
    },
  }
}

function isPrefix(prefix: LanguageModelV3Prompt, messages: LanguageModelV3Prompt) {
  return prefix.every((message, index) => JSON.stringify(message) === JSON.stringify(messages[index]))
}

function containsCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCacheControl)
  if (!value || typeof value !== "object") return false
  if (cacheControl(value)) return true
  return Object.values(value).some(containsCacheControl)
}

function cacheControl(options: unknown) {
  if (!options || typeof options !== "object" || !("anthropic" in options)) return false
  const anthropic = options.anthropic
  if (!anthropic || typeof anthropic !== "object") return false
  return "cacheControl" in anthropic || "cache_control" in anthropic
}

export const LLMMessageTransform = { middleware, ReplayMismatchError }
