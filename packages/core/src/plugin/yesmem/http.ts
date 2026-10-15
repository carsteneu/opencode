// Shared HTTP helpers for the plugin's outbound calls.

const DEFAULTS = { maxChars: 100_000 }

/**
 * Reads a response body up to a character budget.
 *
 * `AbortSignal.timeout` bounds time, not bytes: an endpoint that streams for the whole budget would otherwise
 * buffer hundreds of megabytes into a string before any substring could trim it.
 */
export async function readBodyCapped(response: Response, maxChars: number = DEFAULTS.maxChars): Promise<string> {
  const body = response.body
  if (!body) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // Stop the transfer when the budget is exhausted; the caller only needs the head of the body.
    await reader.cancel().catch(() => {})
  }
  return text.length > maxChars ? text.substring(0, maxChars) : text
}
