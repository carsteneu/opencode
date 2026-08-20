// Minimal JSON-RPC 2.0 LSP-like fake server over stdio that records the
// textDocument lifecycle notifications it receives. Used to assert didOpen /
// didChange / didClose behavior deterministically (no wall-clock assumptions).

let nextId = 1
let readBuffer = Buffer.alloc(0)
const counters = { didOpen: 0, didChange: 0, didClose: 0 }
const versions = []
let diagnosticDelayMs = 200

function defer(fn) {
  setTimeout(fn, diagnosticDelayMs)
}

function encode(message) {
  const json = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(json, "utf8")])
}

function decodeFrames(buffer) {
  const results = []
  let idx
  while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
    const header = buffer.slice(0, idx).toString("utf8")
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    const length = match ? parseInt(match[1], 10) : 0
    const bodyStart = idx + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) break
    results.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"))
    buffer = buffer.slice(bodyEnd)
  }
  return { messages: results, rest: buffer }
}

function sendResponse(id, result) {
  process.stdout.write(encode({ jsonrpc: "2.0", id, result }))
}

function handle(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  if (typeof data.method !== "string") {
    return
  }

  if (data.method === "initialize") {
    sendResponse(data.id, {
      capabilities: {
        textDocumentSync: { change: 2 },
        diagnosticProvider: true,
      },
    })
    return
  }

  if (data.method === "textDocument/diagnostic") {
    defer(() => sendResponse(data.id, { items: [] }))
    return
  }

  if (data.method === "initialized" || data.method === "workspace/didChangeConfiguration") {
    return
  }

  if (data.method === "textDocument/didOpen") {
    counters.didOpen += 1
    versions.push(data.params.textDocument.version)
    return
  }

  if (data.method === "textDocument/didChange") {
    counters.didChange += 1
    versions.push(data.params.textDocument.version)
    return
  }

  if (data.method === "textDocument/didClose") {
    counters.didClose += 1
    return
  }

  if (data.method === "test/publish-diagnostics") {
    process.stdout.write(
      encode({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: data.params,
      }),
    )
    return
  }

  if (data.method === "test/configure-delay") {
    diagnosticDelayMs = Number(data.params?.diagnosticDelayMs ?? 0)
    sendResponse(data.id, null)
    return
  }

  if (data.method === "test/get-counters") {
    sendResponse(data.id, { ...counters, versions })
    return
  }
}

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk])
  const { messages, rest } = decodeFrames(readBuffer)
  readBuffer = rest
  for (const message of messages) handle(message)
})

process.stdin.resume()
