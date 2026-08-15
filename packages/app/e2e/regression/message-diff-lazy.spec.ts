import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  event,
  messageUpdated,
  setupTimeline,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("keeps lazy timeline diffs cached and clears them without loading on invalidation", async ({ page }) => {
  const user = userMessage(undefined, {
    summary: {
      diffs: [{ file: "src/lazy.ts", additions: 1, deletions: 1, status: "modified" }],
    },
  })
  const timeline = await setupTimeline(page, {
    messages: [user, assistantMessage()],
  })

  let requests = 0
  const responses = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  await page.route("**/session/*/diff*", async (route) => {
    const index = requests++
    await responses[index].promise
    await route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: [
        {
          file: "src/lazy.ts",
          patch: `@@ -1 +1 @@\n-before\n+loaded ${index === 0 ? "lazily" : "again"}\n`,
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ],
    })
  })

  const trigger = page.locator('[data-slot="session-turn-diff-trigger"]')
  const detail = page.locator('[data-slot="session-turn-diff-view"]')
  await expect(trigger).toBeVisible()
  expect(requests).toBe(0)
  await trigger.click()
  await expect.poll(() => requests).toBe(1)
  await expect(detail).toHaveCount(0)

  responses[0].resolve()
  await expect(detail).toBeVisible()
  await expect(detail.getByText("loaded lazily", { exact: true })).toBeVisible()

  await timeline.send(
    messageUpdated({
      ...user.info,
      summary: {
        diffs: [{ file: "src/lazy.ts", additions: 2, deletions: 1, status: "modified" }],
      },
    }),
  )
  await timeline.settle()
  expect(requests).toBe(1)
  await expect(detail.getByText("loaded lazily", { exact: true })).toBeVisible()

  await trigger.click()
  await expect(detail).toHaveCount(0)
  await trigger.click()
  await expect(detail.getByText("loaded lazily", { exact: true })).toBeVisible()
  expect(requests).toBe(1)

  await timeline.send(event("message.diff.invalidated", { sessionID: user.info.sessionID, messageID: user.info.id }))
  await timeline.settle()
  await expect(detail).toHaveCount(0)
  expect(requests).toBe(1)

  await timeline.send(
    messageUpdated({
      ...user.info,
      summary: {
        diffs: [{ file: "src/lazy.ts", additions: 3, deletions: 1, status: "modified" }],
      },
    }),
  )
  await timeline.settle()
  expect(requests).toBe(1)

  await trigger.click()
  await trigger.click()
  await timeline.settle()
  await expect(detail).toHaveCount(0)
  expect(requests).toBe(1)

  await timeline.send(event("message.diff.updated", { sessionID: user.info.sessionID, messageID: user.info.id }))
  await expect.poll(() => requests).toBe(2)
  await expect(detail).toHaveCount(0)

  responses[1].resolve()
  await expect(detail.getByText("loaded again", { exact: true })).toBeVisible()

  await trigger.click()
  await expect(detail).toHaveCount(0)
  await trigger.click()
  await expect(detail.getByText("loaded again", { exact: true })).toBeVisible()
  await timeline.settle()
  expect(requests).toBe(2)
})
