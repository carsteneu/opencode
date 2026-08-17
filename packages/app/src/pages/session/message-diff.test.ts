import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { QueryClient } from "@tanstack/solid-query"
import {
  clearMessageDiffQuery,
  hasMessageDiffPatch,
  hydrateMessageDiffs,
  loadMessageDiff,
  messageDiffNeedsLoad,
  messageDiffPendingFiles,
  messageDiffQueryKey,
  messageDiffSessionQueryKey,
  resolveMessageDiff,
  type MessageDiffResult,
} from "./message-diff"

const metadata = {
  file: "src/app.ts",
  additions: 1,
  deletions: 1,
  status: "modified" as const,
}

const detail = {
  ...metadata,
  patch: "@@ -1 +1 @@\n-old\n+new\n",
}

describe("message diff hydration", () => {
  test("keeps metadata visible until a matching patch is loaded", () => {
    expect(hydrateMessageDiffs([metadata], undefined)).toEqual([metadata])
    expect(resolveMessageDiff(metadata, undefined)).toBeUndefined()
  })

  test("replaces metadata with the matching full diff", () => {
    expect(hydrateMessageDiffs([metadata], [detail])).toEqual([detail])
    expect(resolveMessageDiff(metadata, [detail])).toEqual(detail)
  })

  test("keeps current metadata while hydrating an older patch", () => {
    const current = { ...metadata, additions: 4, deletions: 3 }
    expect(hydrateMessageDiffs([current], [detail])).toEqual([{ ...current, patch: detail.patch }])
    expect(resolveMessageDiff(current, [detail])).toEqual({ ...current, patch: detail.patch })
  })

  test("treats a matching patchless loaded row as terminal while keeping current metadata", () => {
    const current = { ...metadata, additions: 4, deletions: 3 }
    const loaded = { ...metadata, additions: 8, deletions: 7 }

    expect(resolveMessageDiff(current, [loaded])).toEqual(current)
    expect(messageDiffPendingFiles([current], [loaded])).toEqual(new Set())
    expect(messageDiffNeedsLoad([current], [current.file], [loaded])).toBe(false)
  })

  test("prefers a matching patch over a patchless duplicate in either order", () => {
    const current = { ...metadata, additions: 4, deletions: 3 }
    const loaded = { ...metadata, additions: 8, deletions: 7 }
    const expected = { ...current, patch: detail.patch }

    expect(resolveMessageDiff(current, [loaded, detail])).toEqual(expected)
    expect(resolveMessageDiff(current, [detail, loaded])).toEqual(expected)
  })

  test("indexes loaded files once and preserves the first matching patch", () => {
    const other = { ...detail, file: "src/other.ts" }
    const duplicate = { ...detail, patch: "duplicate" }
    const loaded = [detail, other, duplicate]
    Object.defineProperty(loaded, "find", {
      value: () => {
        throw new Error("hydrateMessageDiffs must not scan loaded files per summary")
      },
    })

    expect(hydrateMessageDiffs([metadata, { ...metadata, file: other.file }], loaded)).toEqual([detail, other])
  })

  test("does not replace an inline patch with fetched data", () => {
    const newer = { ...detail, patch: "@@ -1 +1 @@\n-old\n+other\n" }
    expect(resolveMessageDiff(detail, [newer])).toEqual(detail)
  })

  test("requests details only when an opened file has no patch", () => {
    expect(messageDiffNeedsLoad([metadata], [])).toBe(false)
    expect(messageDiffNeedsLoad([metadata], ["src/other.ts"])).toBe(false)
    expect(messageDiffNeedsLoad([metadata], [metadata.file])).toBe(true)
    expect(messageDiffNeedsLoad([{ ...metadata, additions: 0, deletions: 0 }], [metadata.file])).toBe(true)
    expect(messageDiffNeedsLoad([detail], [detail.file])).toBe(false)
  })

  test("keeps missing requested paths pending and ignores loaded rows without a file", () => {
    const pending = { ...metadata, file: "src/pending.ts" }
    const inline = { ...detail, file: "src/inline.ts" }
    const anonymous = { additions: 0, deletions: 0, status: "modified" as const }
    const loaded = [{ ...metadata, file: "src/other.ts" }, anonymous]

    expect(resolveMessageDiff(metadata, loaded)).toBeUndefined()
    expect(messageDiffPendingFiles([metadata, inline, pending], loaded)).toEqual(new Set([metadata.file, pending.file]))
    expect(messageDiffNeedsLoad([metadata, inline, pending], [inline.file], loaded)).toBe(false)
    expect(messageDiffNeedsLoad([metadata, inline, pending], [metadata.file], loaded)).toBe(true)
    expect(messageDiffNeedsLoad([metadata, inline, pending], [pending.file], loaded)).toBe(true)
  })

  test("checks large summary, loaded, and requested sets in linear passes", () => {
    const size = 4_096
    const reads = { value: 0 }
    const observe = <T>(values: T[]) =>
      new Proxy(values, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads.value++
          return Reflect.get(target, property, receiver)
        },
      })
    const diffs = Array.from({ length: size }, (_, index) => ({ ...metadata, file: `src/${index}.ts` }))
    const files = diffs.map((diff) => diff.file)

    expect(messageDiffNeedsLoad(observe(diffs), observe(files), observe(diffs.toReversed()))).toBe(false)
    expect(reads.value).toBeLessThanOrEqual(size * 3)
  })

  test("identifies patch text without treating metadata as detail", () => {
    expect(hasMessageDiffPatch(metadata)).toBe(false)
    expect(hasMessageDiffPatch(detail)).toBe(true)
  })
})

describe("message diff cache", () => {
  const input = {
    scope: "local",
    directory: "/repo",
    sessionID: "session",
    messageID: "message",
  }

  test("uses one stable query key per session message", () => {
    expect(messageDiffQueryKey(input)).toEqual([...messageDiffSessionQueryKey(input), input.messageID])
  })

  test("removes a previous session cache without touching the current session", () => {
    const queryClient = new QueryClient()
    const previous = messageDiffQueryKey(input)
    const current = messageDiffQueryKey({ ...input, sessionID: "current" })
    const result = { revision: 1, invalidation: 0, diffs: [detail] }
    queryClient.setQueryData(previous, result)
    queryClient.setQueryData(current, result)

    queryClient.removeQueries({ queryKey: messageDiffSessionQueryKey(input) })
    expect(queryClient.getQueryData(previous)).toBeUndefined()
    expect(queryClient.getQueryData<MessageDiffResult>(current)).toEqual(result)
  })

  test("clears only the invalidated message without issuing a request", () => {
    const queryClient = new QueryClient()
    const queryKey = messageDiffQueryKey(input)
    const other = messageDiffQueryKey({ ...input, messageID: "other" })
    const result = { revision: 1, invalidation: 0, diffs: [detail] }
    queryClient.setQueryData(queryKey, result)
    queryClient.setQueryData(other, result)

    clearMessageDiffQuery(queryClient, queryKey)
    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    expect(queryClient.getQueryData<MessageDiffResult>(other)).toEqual(result)
  })

  test("reuses a collapsed diff and replaces it only for a terminal revision", async () => {
    const queryClient = new QueryClient()
    const queryKey = messageDiffQueryKey(input)
    let calls = 0
    let revision = 0
    const invalidation = 0
    const query = async () => {
      calls++
      return [{ ...detail, patch: `${detail.patch}${calls}` }]
    }

    const current = () => ({ revision, invalidation })
    const first = await loadMessageDiff({ queryClient, queryKey, revision, invalidation, current, query })
    const reopened = await loadMessageDiff({ queryClient, queryKey, revision, invalidation, current, query })
    expect(reopened).toEqual(first)
    expect(calls).toBe(1)

    revision = 1
    const terminal = await loadMessageDiff({ queryClient, queryKey, revision, invalidation, current, query })
    expect(terminal.revision).toBe(1)
    expect(terminal.diffs).not.toEqual(first.diffs)
    expect(calls).toBe(2)
    expect(queryClient.getQueryCache().findAll({ queryKey })).toHaveLength(1)
  })

  test("recovers when a terminal revision arrives during the previous request", async () => {
    const queryClient = new QueryClient()
    const queryKey = messageDiffQueryKey(input)
    const pending = Promise.withResolvers<SnapshotFileDiff[]>()
    let revision = 0
    const invalidation = 0
    let calls = 0
    const first = loadMessageDiff({
      queryClient,
      queryKey,
      revision,
      invalidation,
      current: () => ({ revision, invalidation }),
      query: () => {
        calls++
        return pending.promise
      },
    })

    revision = 1
    const terminal = loadMessageDiff({
      queryClient,
      queryKey,
      revision,
      invalidation,
      current: () => ({ revision, invalidation }),
      query: async () => {
        calls++
        return [{ ...detail, patch: "terminal" }]
      },
    })
    pending.resolve([detail])

    expect((await first).revision).toBe(0)
    expect(await terminal).toEqual({ revision: 1, invalidation: 0, diffs: [{ ...detail, patch: "terminal" }] })
    expect(calls).toBe(2)
    expect(queryClient.getQueryData<MessageDiffResult>(queryKey)).toEqual({
      revision: 1,
      invalidation: 0,
      diffs: [{ ...detail, patch: "terminal" }],
    })
  })
})
