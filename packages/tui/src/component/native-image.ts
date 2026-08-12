import { getComponentCatalogue, type JSX } from "@opentui/solid"

export const nativeImageComponent = "image" as keyof JSX.IntrinsicElements & string

export function supportsNativeImages() {
  return "image" in getComponentCatalogue()
}
