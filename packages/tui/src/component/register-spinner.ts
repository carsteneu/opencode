import { extend, getComponentCatalogue } from "@opentui/solid/components"
import type { RenderContext } from "@opentui/core"
import { SpinnerRenderable, type SpinnerOptions } from "opentui-spinner"

export class OpencodeSpinnerRenderable extends SpinnerRenderable {
  constructor(ctx: RenderContext, options: SpinnerOptions) {
    super(ctx, options)
    this.setPartialEligible(true)
  }
}

export function registerOpencodeSpinner() {
  if (!getComponentCatalogue().spinner) extend({ spinner: OpencodeSpinnerRenderable })
}
