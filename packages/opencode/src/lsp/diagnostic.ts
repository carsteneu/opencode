import * as LSPClient from "./client"

const MAX_PER_FILE = 20

export function compact(issues: LSPClient.Diagnostic[], maximum = MAX_PER_FILE) {
  const seen = new Set<string>()
  return issues.filter((item) => {
    if (item.severity !== 1) return false
    if (seen.size >= maximum) return false
    const key = [
      item.range.start.line,
      item.range.start.character,
      item.range.end.line,
      item.range.end.character,
      item.message,
    ].join(":")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severityMap = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1

  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = compact(issues)
  if (errors.length === 0) return ""
  const more = issues.filter((item) => item.severity === 1).length - errors.length
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${errors.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}

export * as Diagnostic from "./diagnostic"
