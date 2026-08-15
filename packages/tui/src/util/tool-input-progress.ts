export function toolInputProgress(label: string, received?: number) {
  if (!received || received < 1 || !Number.isFinite(received)) return label
  const units = ["B", "KB", "MB", "GB"] as const
  const index = Math.min(Math.floor(Math.log(received) / Math.log(1024)), units.length - 1)
  const value = received / 1024 ** index
  const amount = index === 0 ? Math.round(value) : Number(value.toFixed(value < 10 ? 1 : 0))
  return `${label} (${amount} ${units[index]} received)`
}
