import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { QueryClient } from "@tanstack/solid-query"

const messageDiffCacheTime = 60_000

export type MessageDiffResult = {
  revision: number
  invalidation: number
  diffs: SnapshotFileDiff[]
}

export function hasMessageDiffPatch<T extends object>(diff: T) {
  return "patch" in diff && typeof diff.patch === "string"
}

export function resolveMessageDiff(
  summary: SnapshotFileDiff,
  loaded: readonly SnapshotFileDiff[] | undefined,
): SnapshotFileDiff | undefined {
  if (hasMessageDiffPatch(summary)) return summary
  if (!summary.file) return
  const detail =
    loaded?.find((diff) => diff.file === summary.file && hasMessageDiffPatch(diff)) ??
    loaded?.find((diff) => diff.file === summary.file)
  if (!detail) return
  if (hasMessageDiffPatch(detail)) return { ...detail, ...summary, file: summary.file, patch: detail.patch }
  return { ...detail, ...summary, file: summary.file }
}

export function hydrateMessageDiffs(
  summaries: readonly SnapshotFileDiff[],
  loaded: readonly SnapshotFileDiff[] | undefined,
) {
  if (!loaded) return summaries.slice()
  const details = new Map<string, SnapshotFileDiff>()
  loaded.forEach((diff) => {
    if (!diff.file || !hasMessageDiffPatch(diff) || details.has(diff.file)) return
    details.set(diff.file, diff)
  })
  return summaries.map((summary) => {
    if (hasMessageDiffPatch(summary) || !summary.file) return summary
    const detail = details.get(summary.file)
    if (!detail) return summary
    return { ...detail, ...summary, patch: detail.patch }
  })
}

export function messageDiffNeedsLoad(
  diffs: readonly SnapshotFileDiff[],
  files: readonly string[],
  loaded?: readonly SnapshotFileDiff[],
) {
  if (files.length === 0) return false
  const pending = messageDiffPendingFiles(diffs, loaded)
  return files.some((file) => pending.has(file))
}

export function messageDiffPendingFiles(diffs: readonly SnapshotFileDiff[], loaded?: readonly SnapshotFileDiff[]) {
  const terminal = new Set(loaded?.flatMap((diff) => (diff.file ? [diff.file] : [])))
  return new Set(
    diffs.flatMap((diff) => (diff.file && !hasMessageDiffPatch(diff) && !terminal.has(diff.file) ? [diff.file] : [])),
  )
}

export function messageDiffSessionQueryKey(input: { scope: string; directory: string; sessionID: string }) {
  return [input.scope, "message-diff", input.directory, input.sessionID] as const
}

export function messageDiffQueryKey(input: { scope: string; directory: string; sessionID: string; messageID: string }) {
  return [...messageDiffSessionQueryKey(input), input.messageID] as const
}

export function clearMessageDiffQuery(queryClient: QueryClient, queryKey: ReturnType<typeof messageDiffQueryKey>) {
  void queryClient.cancelQueries({ queryKey, exact: true })
  queryClient.removeQueries({ queryKey, exact: true })
}

export async function loadMessageDiff(input: {
  queryClient: QueryClient
  queryKey: ReturnType<typeof messageDiffQueryKey>
  revision: number
  invalidation: number
  current: () => { revision: number; invalidation: number }
  query: () => Promise<SnapshotFileDiff[]>
}) {
  const fetch = () => {
    const cached = input.queryClient.getQueryData<MessageDiffResult>(input.queryKey)
    return input.queryClient.fetchQuery({
      queryKey: input.queryKey,
      staleTime:
        cached?.revision === input.revision && cached.invalidation === input.invalidation
          ? Number.POSITIVE_INFINITY
          : 0,
      gcTime: messageDiffCacheTime,
      retry: 2,
      queryFn: () =>
        input.query().then((diffs) => ({
          revision: input.revision,
          invalidation: input.invalidation,
          diffs,
        })),
    })
  }

  const result = await fetch()
  if (result.revision === input.revision && result.invalidation === input.invalidation) return result
  const current = input.current()
  if (current.revision !== input.revision || current.invalidation !== input.invalidation) return result
  await input.queryClient.invalidateQueries({ queryKey: input.queryKey, exact: true, refetchType: "none" })
  return fetch()
}
