import { crc32, deflateSync } from "node:zlib"

// Small images carry real pixels, so a preview can decode and cut them. Large ones stay header-plus-empty
// frame, which is all the pixel-budget tests need and costs nothing to declare.
const PIXELLED_LIMIT = 512

export function sizedImage(width: number, height: number): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = width * height <= PIXELLED_LIMIT * PIXELLED_LIMIT ? pixelData(width, height) : emptyFrame()
  const data = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${data.toString("base64")}`
}

/** One filter byte then three bytes per pixel, deterministic so two runs produce the same bytes. */
function pixelData(width: number, height: number) {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = (x * 5) % 256
    row[2 + x * 3] = (x * 3) % 256
    row[3 + x * 3] = 128
  }
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => {
    const copy = Buffer.from(row)
    copy[1] = (copy[1]! + y * 2) % 256
    return copy
  }))
  return deflateSync(raw)
}

function emptyFrame() {
  return Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])
}

function chunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(payload.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
  return out
}
