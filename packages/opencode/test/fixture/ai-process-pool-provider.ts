import path from "node:path"

let initializations = 0

export async function initialize(state: string) {
  initializations++
  await Bun.write(path.join(state, `provider-${process.pid}-${initializations}`), String(process.pid))
  return () => initializations
}
