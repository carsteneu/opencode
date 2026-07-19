import type { ImageModel } from "../image"
import { AlibabaImages, type AlibabaImageOptions, type Family } from "../protocols/alibaba-images"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { HttpOptions, ProviderID, mergeHttpOptions } from "../schema"

export type { AlibabaImageOptions, QwenImageOptions, WanColor, WanImageOptions } from "../protocols/alibaba-images"

export type AlibabaImageModelID = "qwen-image-2.0" | "qwen-image-2.0-pro" | "wan2.7-image" | "wan2.7-image-pro"

export const id = ProviderID.make("alibaba")

export type Config = ProviderAuthOption<"optional"> & {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  readonly http?: HttpOptions.Input
  readonly image?: {
    readonly providerOptions?: AlibabaImageOptions
  }
}

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "DASHSCOPE_API_KEY")

const family = (modelID: AlibabaImageModelID): Family => (modelID.startsWith("qwen-") ? "qwen" : "wan")

export const configure = (input: Config = {}) => {
  const image = (modelID: AlibabaImageModelID): ImageModel =>
    AlibabaImages.model({
      id: modelID,
      family: family(modelID),
      auth: auth(input),
      baseURL: input.baseURL,
      headers: input.headers,
      defaults: {
        providerOptions:
          input.image?.providerOptions === undefined ? undefined : { alibaba: { ...input.image.providerOptions } },
        http: mergeHttpOptions(input.http === undefined ? undefined : HttpOptions.make(input.http)),
      },
    })

  return {
    id,
    image,
    configure,
  }
}

export const provider = configure()
export const image = provider.image
