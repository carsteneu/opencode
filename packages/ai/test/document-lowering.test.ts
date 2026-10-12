import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Anthropic from "../src/providers/anthropic.js"
import * as DigitalOcean from "../src/providers/digitalocean.js"
import * as Groq from "../src/providers/groq.js"
import * as Minimax from "../src/providers/minimax.js"
import * as Moonshot from "../src/providers/moonshot.js"
import * as OpenAI from "../src/providers/openai.js"
import * as OpenRouter from "../src/providers/openrouter.js"
import * as AlibabaChat from "../src/protocols/alibaba-chat.js"
import * as AlibabaResponses from "../src/protocols/alibaba-responses.js"
import * as AnthropicMessages from "../src/protocols/anthropic-messages.js"
import * as BedrockConverse from "../src/protocols/bedrock-converse.js"
import * as GoogleInteractions from "../src/protocols/google-interactions.js"
import * as MetaResponses from "../src/protocols/meta-responses.js"
import * as MistralChat from "../src/protocols/mistral-chat.js"
import * as OpenAIChat from "../src/protocols/openai-chat.js"
import * as OpenAIResponses from "../src/protocols/openai-responses.js"
import * as OpenResponses from "../src/protocols/open-responses.js"
import { gatewayProtocol } from "../src/protocols/utils/gateway-protocol.js"
import * as VeniceChat from "../src/protocols/venice-chat.js"
import * as XAIResponses from "../src/protocols/xai-responses.js"
import * as ZAIChat from "../src/protocols/zai-chat.js"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

const withProtocol = <T extends { readonly protocol: string }>(routes: readonly T[], protocol: string): T => {
  const found = routes.find((item) => item.protocol === protocol)
  if (found === undefined) throw new Error(`no route declared for ${protocol}`)
  return found
}

/**
 * Core reads this capability off the route to decide whether an office attachment can travel or must become a visible
 * notice, so every protocol that lowers one inline without declaring it silently loses the attachment. Each entry
 * wraps a lowering that emits a file or document part: the chat family (`OpenAIChat.fromRequest`), the responses
 * family (`OpenResponses.fromRequestWithAdapter`) and Bedrock's own document blocks.
 */
describe("lowersDocument", () => {
  test("every protocol that lowers office documents inline declares the capability", () => {
    const carriers = [
      OpenAIChat.protocol,
      OpenResponses.protocol,
      OpenAIResponses.protocol,
      XAIResponses.protocol,
      MetaResponses.protocol,
      AlibabaResponses.protocol,
      AlibabaChat.protocol,
      VeniceChat.protocol,
      ZAIChat.protocol,
      BedrockConverse.protocol,
      Groq.protocol,
      DigitalOcean.protocol,
      OpenRouter.protocol,
      withProtocol(Minimax.routes, "minimax-chat"),
      withProtocol(Moonshot.routes, "moonshot-chat"),
    ]

    for (const carrier of carriers) expect([carrier.id, carrier.lowersDocument?.(DOCX)]).toEqual([carrier.id, true])
  })

  test("protocols that refuse office documents do not declare the capability", () => {
    expect(AnthropicMessages.protocol.lowersDocument).toBeUndefined()
    expect(GoogleInteractions.protocol.lowersDocument).toBeUndefined()
    expect(MistralChat.protocol.lowersDocument).toBeUndefined()
  })

  test("Bedrock declares exactly the office formats its document blocks accept", () => {
    const lowers = BedrockConverse.protocol.lowersDocument
    expect(lowers?.("application/msword")).toBe(true)
    expect(lowers?.(DOCX)).toBe(true)
    expect(lowers?.("application/vnd.ms-excel")).toBe(true)
    expect(lowers?.("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true)
    expect(lowers?.(PPTX)).toBe(false)
    expect(lowers?.("application/vnd.oasis.opendocument.text")).toBe(false)
  })

  test("routes forward the protocol capability", () => {
    expect(OpenAI.responses("gpt-5.4-mini").route.lowersDocument?.(DOCX)).toBe(true)
    expect(OpenAI.chat("gpt-4o").route.lowersDocument?.(DOCX)).toBe(true)
    expect(Anthropic.routes.map((route) => route.lowersDocument)).toEqual([undefined])
  })

  test("the gateway factory forwards the capability of the protocol it wraps", () => {
    const forwarded = gatewayProtocol(OpenAIChat.protocol, {
      id: "gateway-chat",
      prepare: (request) => Effect.succeed({ request, body: {} }),
    })

    expect(forwarded.lowersDocument?.(DOCX)).toBe(true)
  })
})
