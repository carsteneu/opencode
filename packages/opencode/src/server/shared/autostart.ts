// The systemd user service starts this process unconditionally at login, so the
// on/off switch has to live in the config, not in the unit: absent means on
// (the service is the default, opting out is the exception), and flipping the
// key takes effect the next time the service starts — nothing to uninstall.

export function shouldAutostart(sharedServerAutostart: boolean | undefined): boolean {
  return sharedServerAutostart !== false
}

export * as SharedAutostart from "./autostart"
