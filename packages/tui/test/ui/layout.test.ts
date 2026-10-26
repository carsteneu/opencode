import { expect, test } from "bun:test"
import {
  clampSessionReplayWidth,
  clampSessionSidebarWidth,
  clampSessionTabsWidth,
  sessionTabsFitVertically,
  SESSION_REPLAY_MIN_WIDTH,
  SESSION_REPLAY_WIDTH,
  SESSION_SIDEBAR_MAX_WIDTH,
  SESSION_SIDEBAR_MIN_WIDTH,
  SESSION_SIDEBAR_WIDTH,
  SESSION_TABS_COMPACT_WIDTH,
} from "../../src/ui/layout"

test("vertical tabs match the session sidebar and preserve readable content width", () => {
  expect(SESSION_SIDEBAR_WIDTH).toBe(42)
  expect(sessionTabsFitVertically(106)).toBe(true)
  expect(sessionTabsFitVertically(105)).toBe(false)
})

test("vertical tabs account for a resized width", () => {
  expect(sessionTabsFitVertically(124, 60)).toBe(true)
  expect(sessionTabsFitVertically(123, 60)).toBe(false)
})

test("vertical tab width preserves minimum rail and content widths", () => {
  expect(clampSessionTabsWidth(0, 120)).toBe(SESSION_TABS_COMPACT_WIDTH)
  expect(clampSessionTabsWidth(11, 120)).toBe(11)
  expect(clampSessionTabsWidth(12, 120)).toBe(12)
  expect(clampSessionTabsWidth(50, 120)).toBe(50)
  expect(clampSessionTabsWidth(100, 120)).toBe(SESSION_SIDEBAR_MAX_WIDTH)
  expect(clampSessionTabsWidth(100, 100)).toBe(56)
  expect(clampSessionTabsWidth(42, 54)).toBe(10)
  expect(sessionTabsFitVertically(69, SESSION_TABS_COMPACT_WIDTH)).toBe(true)
  expect(sessionTabsFitVertically(68, SESSION_TABS_COMPACT_WIDTH)).toBe(false)
})

test("the replay width keeps its floor, its default and the transcript's minimum", () => {
  expect(SESSION_REPLAY_MIN_WIDTH).toBe(24)
  expect(clampSessionReplayWidth(1, 160)).toBe(SESSION_REPLAY_MIN_WIDTH)
  expect(clampSessionReplayWidth(SESSION_REPLAY_WIDTH, 160)).toBe(SESSION_REPLAY_WIDTH)
  // The maximum is whatever is left after the transcript's 44 columns.
  expect(clampSessionReplayWidth(500, 160)).toBe(160 - 44)
  expect(clampSessionReplayWidth(500, 200)).toBe(200 - 44)
  // Narrow rows keep the equal split, like the right pane's clamp.
  expect(clampSessionReplayWidth(80, 80)).toBe(40)
  expect(clampSessionReplayWidth(80, 40)).toBe(20)
})

test("the sidebar width keeps its floor, the tab rail's ceiling and the transcript's minimum", () => {
  expect(clampSessionSidebarWidth(1, 160)).toBe(SESSION_SIDEBAR_MIN_WIDTH)
  expect(clampSessionSidebarWidth(SESSION_SIDEBAR_WIDTH, 160)).toBe(SESSION_SIDEBAR_WIDTH)
  expect(clampSessionSidebarWidth(500, 160)).toBe(SESSION_SIDEBAR_MAX_WIDTH)
  // The ceiling yields to the transcript's 44 columns before it reaches the rail maximum.
  expect(clampSessionSidebarWidth(500, 100)).toBe(100 - 44)
  expect(clampSessionSidebarWidth(30, 160)).toBe(SESSION_SIDEBAR_MIN_WIDTH)
})
