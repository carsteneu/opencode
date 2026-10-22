/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { OptimizedBuffer } from "@opentui/core"
import { tmpdir } from "./fixture/fixture"
import {
  attachment,
  collectImages,
  findTranscript,
  historyMessage,
  imageFile,
  markdownBody,
  renderSession,
  sizedImage,
  TERMINAL_WIDTH,
  textMessage,
  toolMessage,
  userMessage,
  type SessionImageFixture,
} from "./fixture/session-images"

// Characterization matrix for preview residency. Each row answers one question: after the preview is
// scrolled out of the transcript window and back, is it drawn again? The scroll position, the mounted
// previews and the on-screen marker are printed for every step, so each row carries its own evidence.
let rasterize: typeof OptimizedBuffer.prototype.drawImage
beforeAll(() => {
  rasterize = OptimizedBuffer.prototype.drawImage
  // 0.6.6 reports whether the image was drawn; claiming success keeps the renderer from
  // retrying the frame forever, which is all this stub needs to do for a text-only assertion.
  OptimizedBuffer.prototype.drawImage = () => true
})
afterAll(() => {
  OptimizedBuffer.prototype.drawImage = rasterize
})

const HISTORY = 45
const TAIL_MARKER = `History message ${String(HISTORY - 1).padStart(4, "0")}`

// One explicit frame plus a short pause. With an image mounted, 0.6.6 never reports a native frame as
// committed in the test harness, so the idle helpers behind waitForVisualIdle would spin until the test
// times out; renderOnce still advances the tree, which is all these assertions need.
const tick = async (setup: { renderOnce: () => Promise<unknown> }) => {
  await setup.renderOnce()
  await Bun.sleep(5)
}

type Kind = "user attachment" | "tool result" | "markdown reference"
type Placement = "oldest" | "tail"

async function fixtureFor(kind: Kind, placement: Placement, state: string): Promise<SessionImageFixture> {
  const target = await imageFile(state, "chart.png", 96, 48)
  const carried =
    kind === "user attachment"
      ? userMessage([attachment(sizedImage(96, 48), "sun.png")])
      : kind === "tool result"
        ? toolMessage([sizedImage(96, 48)])
        : textMessage(markdownBody(target))
  const history = Array.from({ length: HISTORY }, (_, index) => historyMessage(index))
  return {
    messages: placement === "oldest" ? [carried, ...history] : [...history, carried],
    directory: state,
    // The mount window is tail-first, so only the oldest placement starts out unmounted.
    mountedAtStart: placement === "tail",
    marker: kind === "user attachment" ? "Look at this" : kind === "markdown reference" ? "Shot:" : undefined,
  }
}

type Outcome = { previews: number[]; frames: string[] }

/**
 * Drives one transcript with the wheel, which is the input that backfills older rows, and records
 * what the transcript looked like at the newest end, at the oldest end, and after coming back.
 */
async function excursion(
  fixture: SessionImageFixture,
  options: { width: number; height: number; tiny?: boolean },
  label: string,
): Promise<Outcome> {
  const { setup, server, task } = await renderSession(fixture.directory, fixture.messages, {
    directory: fixture.directory,
    width: options.width,
    height: options.height,
  })
  const outcome: Outcome = { previews: [], frames: [] }
  try {
    const previews = () => collectImages(setup.renderer.root).length
    // Settle without the harness wait helpers: their internal predicate reporting masks which
    // observation actually failed. Either signal proves the load settled - the tail row is on screen
    // when the preview sits at the oldest end, and the preview itself when it sits at the newest end.
    const settled = async () => {
      for (let attempt = 0; attempt < 80; attempt++) {
        await tick(setup)
        if (previews() > 0 || setup.captureCharFrame().includes(TAIL_MARKER)) return
      }
      throw new Error("the transcript never settled")
    }
    await settled()
    await tick(setup)
    const scroll = findTranscript(setup.renderer.root, `history-${HISTORY - 1}`)
    if (!scroll) throw new Error("session transcript scrollbox was not found")

    const record = (phase: string) => {
      const frame = setup.captureCharFrame()
      // Read once: the logged number and the recorded one must be the same observation.
      const mounted = previews()
      outcome.previews.push(mounted)
      outcome.frames.push(frame)
      console.log(
        `[${label} | ${phase}] scrollTop=${scroll.scrollTop}/${scroll.scrollHeight - scroll.viewport.height} ` +
          `previews=${mounted} markerVisible=${fixture.marker ? frame.includes(fixture.marker) : "n/a"}`,
      )
    }
    const maximum = () => Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    // Exact ends, deliberately: the transcript only re-tightens its mount window back to the tail when
    // it truly reaches the bottom, so a tolerant comparison would leave an older row mounted and
    // change what "back at the newest end" means. The budget is generous instead.
    const atOldest = () => scroll.scrollTop <= 0
    const atNewest = () => scroll.scrollTop >= maximum()
    const wheelUntil = async (direction: "up" | "down", reached: () => boolean, phase: string) => {
      for (let step = 1; step <= 700; step++) {
        await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, direction)
        await tick(setup)
        if (reached()) return step
      }
      throw new Error(
        `scrolling ${direction} never reached the ${phase} end (scrollTop=${scroll.scrollTop}, maximum=${maximum()})`,
      )
    }
    const wheel = async (direction: "up" | "down", times: number) => {
      for (let index = 0; index < times; index++) {
        await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, direction)
        await tick(setup)
      }
    }

    record("at the newest end")
    if (options.tiny) {
      await wheel("up", 3)
      record("after a tiny scroll up")
      await wheel("down", 3)
      record("after a tiny scroll back")
      return outcome
    }

    await wheelUntil("up", atOldest, "oldest")
    record("at the oldest end")
    await wheelUntil("down", atNewest, "newest")
    record("back at the newest end")
    await wheelUntil("up", atOldest, "oldest")
    record("at the oldest end again")
    return outcome
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

const CASES: { name: string; kind: Kind; placement: Placement }[] = [
  { name: "user attachment as the oldest row", kind: "user attachment", placement: "oldest" },
  { name: "user attachment as the newest row", kind: "user attachment", placement: "tail" },
  { name: "tool result as the oldest row", kind: "tool result", placement: "oldest" },
  { name: "tool result as the newest row", kind: "tool result", placement: "tail" },
  { name: "markdown reference as the oldest row", kind: "markdown reference", placement: "oldest" },
  { name: "markdown reference as the newest row", kind: "markdown reference", placement: "tail" },
]

for (const entry of CASES) {
  test(`keeps the preview reachable: ${entry.name}`, async () => {
    await using state = await tmpdir()
    const fixture = await fixtureFor(entry.kind, entry.placement, state.path)
    const outcome = await excursion(fixture, { width: TERMINAL_WIDTH, height: 34 }, entry.name)
    const [initial, oldest, newest, returned] = outcome.previews as [number, number, number, number]
    const [initialFrame, oldestFrame, newestFrame, returnedFrame] = outcome.frames

    // One assertion for the whole excursion so the report names the phase that disagreed.
    expect({ initial, oldest, newest, returned }).toEqual({
      initial: fixture.mountedAtStart ? 1 : 0,
      oldest: 1,
      newest: entry.placement === "oldest" ? 0 : 1,
      // The point of the row: the preview is drawn again after the excursion.
      returned: 1,
    })

    if (fixture.marker) {
      // The marker only lives on the row that carries the preview, so it says whether that row is on
      // screen rather than merely mounted. The row is at the oldest end or at the newest end, never both.
      const markerAtOldest = entry.placement === "oldest"
      expect(initialFrame.includes(fixture.marker)).toBe(!markerAtOldest)
      expect(oldestFrame.includes(fixture.marker)).toBe(markerAtOldest)
      expect(newestFrame.includes(fixture.marker)).toBe(!markerAtOldest)
      expect(returnedFrame.includes(fixture.marker)).toBe(markerAtOldest)
    }
  }, 180000)
}

test("keeps a mounted preview across a tiny scroll", async () => {
  await using state = await tmpdir()
  const fixture = await fixtureFor("markdown reference", "tail", state.path)
  const outcome = await excursion(fixture, { width: TERMINAL_WIDTH, height: 34, tiny: true }, "tiny movement")
  // A small movement must not drop and re-add a preview that is already mounted.
  expect(outcome.previews).toEqual([1, 1, 1])
  expect(outcome.frames).toHaveLength(3)
}, 60000)

test("keeps the preview reachable on a short narrow terminal", async () => {
  await using state = await tmpdir()
  const fixture = await fixtureFor("markdown reference", "oldest", state.path)
  const outcome = await excursion(fixture, { width: 64, height: 20 }, "markdown reference 64x20")
  expect(outcome.previews).toEqual([0, 1, 0, 1])
  expect(outcome.frames[1]).toContain("Shot:")
  expect(outcome.frames[3]).toContain("Shot:")
}, 180000)
