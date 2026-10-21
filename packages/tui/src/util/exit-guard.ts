export type ExitGuard = {
  press: () => "armed" | "fire"
  armed: () => boolean
  reset: () => void
}

export function createExitGuard(input: { windowMs: number; now?: () => number }): ExitGuard {
  const now = input.now ?? Date.now
  let armedAt = -Infinity
  return {
    press: () => {
      const time = now()
      if (time - armedAt < input.windowMs) {
        armedAt = -Infinity
        return "fire"
      }
      armedAt = time
      return "armed"
    },
    armed: () => now() - armedAt < input.windowMs,
    reset: () => {
      armedAt = -Infinity
    },
  }
}
