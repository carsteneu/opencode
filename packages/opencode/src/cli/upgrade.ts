import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { errorMessage } from "@/util/error"
import { Effect } from "effect"

export async function upgrade(input?: { autoupdate?: ConfigV1.Info["autoupdate"] }) {
  const autoupdate = input
    ? input.autoupdate
    : (await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))).autoupdate
  if (autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch((error) =>
    AppRuntime.runPromise(Effect.logWarning("automatic update check failed", { error: errorMessage(error) })).then(
      () => undefined,
    ),
  )
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (!Installation.isNewer(InstallationVersion, latest)) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (autoupdate === "notify" || (!Installation.isPatched() && kind !== "patch")) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch((error) =>
      AppRuntime.runPromise(
        Effect.logWarning("automatic update failed", { version: latest, error: errorMessage(error) }),
      ),
    )
}
