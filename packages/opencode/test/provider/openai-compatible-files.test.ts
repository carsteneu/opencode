import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { convertToOpenAICompatibleChatMessages } from "@ai-sdk/openai-compatible/internal"
import { generateText } from "ai"

describe("OpenAI-compatible file serialization", () => {
  test.each([
    ["application/pdf", "document.pdf"],
    ["application/msword", "document.doc"],
    ["application/vnd.ms-excel", "spreadsheet.xls"],
    ["application/vnd.ms-powerpoint", "slides.ppt"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document.docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spreadsheet.xlsx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides.pptx"],
    ["application/vnd.oasis.opendocument.text", "document.odt"],
    ["application/vnd.oasis.opendocument.spreadsheet", "spreadsheet.ods"],
    ["application/vnd.oasis.opendocument.presentation", "slides.odp"],
  ])("serializes %s as file content", (mediaType, filename) => {
    const prompt = [
      {
        role: "user",
        content: [{ type: "file", data: new Uint8Array([0, 1, 2, 255]), mediaType, filename }],
      },
    ] satisfies LanguageModelV3Prompt

    expect(convertToOpenAICompatibleChatMessages(prompt)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename,
              file_data: `data:${mediaType};base64,AAEC/w==`,
            },
          },
        ],
      },
    ])
  })

  test("serializes arbitrary binary documents as file content", () => {
    expect(
      convertToOpenAICompatibleChatMessages([
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([3, 4, 5]),
              mediaType: "application/octet-stream",
              filename: "document.bin",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename: "document.bin",
              file_data: "data:application/octet-stream;base64,AwQF",
            },
          },
        ],
      },
    ])
  })

  test("keeps text files on the text path", () => {
    expect(
      convertToOpenAICompatibleChatMessages([
        {
          role: "user",
          content: [{ type: "file", data: new TextEncoder().encode("hello"), mediaType: "text/plain" }],
        },
      ]),
    ).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
  })

  test("rejects URL-backed generic files", () => {
    expect(() =>
      convertToOpenAICompatibleChatMessages([
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new URL("https://example.com/document.custom"),
              mediaType: "application/x-custom-document",
            },
          ],
        },
      ]),
    ).toThrow("file parts with URLs for media type application/x-custom-document")
  })

  test("preserves the PDF default filename", () => {
    const result = convertToOpenAICompatibleChatMessages([
      {
        role: "user",
        content: [{ type: "file", data: new Uint8Array([0]), mediaType: "application/pdf" }],
      },
    ])

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename: "document.pdf",
              file_data: "data:application/pdf;base64,AA==",
            },
          },
        ],
      },
    ])
  })

  test("serializes the fallback through the public provider request path", async () => {
    let body: unknown
    const model = createOpenAICompatible({
      name: "test",
      baseURL: "https://example.com/v1",
      apiKey: "test",
      fetch: Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          body = JSON.parse(String(args[1]?.body))
          return Response.json({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "test",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })("test")

    await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAEC/w==",
              mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              filename: "document.docx",
            },
          ],
        },
      ],
      maxRetries: 0,
    })

    expect(body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "document.docx",
                file_data:
                  "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAEC/w==",
              },
            },
          ],
        },
      ],
    })
  })
})
