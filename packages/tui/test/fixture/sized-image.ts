import { crc32 } from "node:zlib"

// A PNG carrying only a header and an empty frame: enough for the decoder's
// dimension probe, cheap enough to declare sizes far above any pixel budget.
export function sizedImage(width: number, height: number): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const data = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${data.toString("base64")}`
}

function chunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(payload.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
  return out
}
