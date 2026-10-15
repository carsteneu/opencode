// YesMem daemon client.
//
// Ported from the v1 plugin (~/.local/share/yesmem/plugins/opencode-yesmem/rpc.ts) but with a different
// transport: v1 shelled out to `echo <json> | nc -U -N -w N <socket>` through `Bun.$`. That needs `nc` on
// PATH and the Bun runtime. The v2 server can run under Bun or Node, so the socket is dialed with
// `node:net` instead — no shell, no external binary, no runtime-specific globals.
//
// Wire protocol (unchanged, see internal/daemon/socket.go handleConn): one JSON request object per line
// `{"method":string,"params":object}`, answered by one JSON object per line
// `{"result":...}` or `{"error":string}`.

import { homedir } from "node:os"
import { connect } from "node:net"
import type { RPCResponse } from "./types"

const DEFAULT_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 1024 * 1024

function defaultSocketPath() {
  if (process.env.YESMEM_SOCKET) return process.env.YESMEM_SOCKET
  return `${process.env.HOME || homedir()}/.claude/yesmem/daemon.sock`
}

export class YesMemRPC {
  private socketPath: string

  constructor(socketPath?: string) {
    this.socketPath = socketPath || defaultSocketPath()
  }

  /** The socket this client dials; subprocesses are handed the same path. */
  get socket(): string {
    return this.socketPath
  }

  call(method: string, params?: Record<string, any>, opts?: { timeoutMs?: number }): Promise<RPCResponse> {
    // Callers that must never block (e.g. the live-ledger subscriber) pass a shorter bound.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const payload = JSON.stringify({ method, params: params || {} }) + "\n"

    return new Promise<RPCResponse>((resolve) => {
      let settled = false
      let buffer = ""
      let bytes = 0
      const socket = connect({ path: this.socketPath })

      const finish = (response: RPCResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(response)
      }

      // Callers render these messages into model-visible text, so only the daemon's bounded `error` field is
      // passed through — never the raw peer bytes that failed to parse.
      const parse = (text: string): RPCResponse => {
        const trimmed = text.trim()
        if (!trimmed) return { ok: false, error: "empty response" }
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed?.error) return { ok: false, error: String(parsed.error).substring(0, 500) }
          // The daemon wraps successful responses in {result: ...}; unwrap it so callers see clean data.
          return { ok: true, result: parsed?.result !== undefined ? parsed.result : parsed }
        } catch {
          return { ok: false, error: "unparseable response" }
        }
      }

      const timer = setTimeout(() => finish({ ok: false, error: `rpc timeout after ${timeoutMs}ms` }), timeoutMs)

      socket.on("connect", () => {
        socket.write(payload)
        // Half-close after the request: the daemon's decoder then reads EOF, handleConn returns and the
        // connection closes, so no caller waits on the keep-alive loop.
        socket.end()
      })
      socket.on("data", (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_RESPONSE_BYTES) {
          finish({ ok: false, error: "response too large" })
          return
        }
        buffer += chunk.toString()
        const newline = buffer.indexOf("\n")
        if (newline !== -1) finish(parse(buffer.slice(0, newline)))
      })
      socket.on("end", () => finish(parse(buffer)))
      socket.on("close", () => finish(parse(buffer)))
      socket.on("error", (error: Error) => finish({ ok: false, error: `rpc error: ${error.message}` }))
    })
  }
}
