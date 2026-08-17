import { normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = {
  filePath?: string
  relativePath?: string
  type?: Kind
  patch?: string
  diff?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  movePath?: string
}

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown) {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

export function patchFile(raw: unknown): ApplyPatchFile | undefined {
  if (!raw || typeof raw !== "object") return

  const value = raw as Raw
  const type = kind(value.type)
  const filePath = typeof value.filePath === "string" ? value.filePath : undefined
  const relativePath = typeof value.relativePath === "string" ? value.relativePath : filePath
  const patch = typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : undefined
  const before = typeof value.before === "string" ? value.before : undefined
  const after = typeof value.after === "string" ? value.after : undefined
  const additions =
    typeof value.additions === "number" && Number.isFinite(value.additions) ? value.additions : undefined
  const deletions =
    typeof value.deletions === "number" && Number.isFinite(value.deletions) ? value.deletions : undefined

  if (!type || !filePath || !relativePath) return
  if (!patch && before === undefined && after === undefined && (additions === undefined || deletions === undefined))
    return

  const resolvedAdditions = additions ?? 0
  const resolvedDeletions = deletions ?? 0
  const movePath = typeof value.movePath === "string" ? value.movePath : undefined

  return {
    filePath,
    relativePath,
    type,
    additions: resolvedAdditions,
    deletions: resolvedDeletions,
    movePath,
    view: normalize({
      file: relativePath,
      patch,
      before,
      after,
      additions: resolvedAdditions,
      deletions: resolvedDeletions,
      status: status(type),
    }),
  }
}

export function patchFiles(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}
