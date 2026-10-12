// Serialization-only worker: measures what crossing the worker boundary costs
// for a growing payload, with no parsing in the way.
/// <reference lib="webworker" />
self.onmessage = (event: MessageEvent<{ id: number; text?: string; suffix?: string }>) => {
  const payload = event.data.text ?? event.data.suffix
  if (typeof payload !== "string") throw new Error("echo payload must be a string")
  self.postMessage({ id: event.data.id, length: payload.length })
}
