import { asSchema, jsonSchema, type Tool } from "ai"

const execute: NonNullable<Tool["execute"]> = async () => {
  throw new Error("Tool execution is disabled for this request")
}

export async function blockedTools(tools: Record<string, Tool>): Promise<Record<string, Tool>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(tools).map(
        async ([name, item]) =>
          [
            name,
            {
              ...item,
              inputSchema: jsonSchema(await asSchema(item.inputSchema).jsonSchema),
              outputSchema: item.outputSchema ? jsonSchema(await asSchema(item.outputSchema).jsonSchema) : undefined,
              execute,
              onInputStart: undefined,
              onInputDelta: undefined,
              onInputAvailable: undefined,
              needsApproval: undefined,
              toModelOutput: undefined,
            } satisfies Tool,
          ] as const,
      ),
    ),
  )
}
