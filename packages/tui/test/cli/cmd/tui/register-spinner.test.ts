import { expect, test } from "bun:test"
import { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { OpencodeSpinnerRenderable } from "../../../../src/component/register-spinner"

test("opencode spinner requests partial renders by default", async () => {
  const app = await createTestRenderer({ width: 20, height: 4 })
  const spinner = new OpencodeSpinnerRenderable(app.renderer, {
    frames: ["a", "b"],
    interval: 100,
    autoplay: false,
  })
  app.renderer.root.add(spinner)
  await app.renderOnce()

  const requests: unknown[] = []
  app.renderer.requestPartialRender = (renderable) => {
    requests.push(renderable)
  }
  spinner.requestRender()

  expect(spinner).toBeInstanceOf(Renderable)
  expect(requests).toEqual([spinner])
  app.renderer.destroy()
})
