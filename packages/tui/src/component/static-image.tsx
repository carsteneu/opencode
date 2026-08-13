import { FrameBufferRenderable, RGBA, type RenderContext, type RenderableOptions } from "@opentui/core"
import { extend } from "@opentui/solid"
import { ptr } from "bun:ffi"
import type { SessionImageSnapshot } from "../util/session-image-snapshot"

const transparent = RGBA.fromValues(0, 0, 0, 0)

type SessionStaticImageOptions = RenderableOptions<FrameBufferRenderable> & {
  snapshot?: SessionImageSnapshot
}

export class SessionStaticImageRenderable extends FrameBufferRenderable {
  private current?: SessionImageSnapshot

  constructor(ctx: RenderContext, options: SessionStaticImageOptions = {}) {
    super(ctx, {
      ...options,
      width: options.snapshot?.width ?? 1,
      height: options.snapshot?.height ?? 1,
      live: false,
      respectAlpha: true,
    })
    this.current = options.snapshot
    this.paint()
  }

  public get snapshot() {
    return this.current
  }

  public set snapshot(snapshot: SessionImageSnapshot | undefined) {
    if (this.current === snapshot) return
    this.current = snapshot
    if (!snapshot) {
      this.paint()
      this.requestRender()
      return
    }
    this.width = snapshot.width
    this.height = snapshot.height
    this.paint()
    this.requestRender()
  }

  protected override onResize(width: number, height: number) {
    super.onResize(width, height)
    this.paint()
  }

  private paint() {
    if (!this.current) {
      this.frameBuffer.clear(transparent)
      return
    }
    this.frameBuffer.clear(transparent)
    this.frameBuffer.drawSuperSampleBuffer(
      0,
      0,
      ptr(this.current.pixels),
      this.current.pixels.byteLength,
      "rgba8unorm",
      this.current.pixelWidth * 4,
    )
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    session_static_image: typeof SessionStaticImageRenderable
  }
}

extend({ session_static_image: SessionStaticImageRenderable })

export function SessionStaticImage(props: { snapshot: SessionImageSnapshot }) {
  return <session_static_image snapshot={props.snapshot} width={props.snapshot.width} height={props.snapshot.height} />
}
