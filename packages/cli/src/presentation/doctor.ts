import type { DoctorCheck, DoctorFinding, DoctorReport } from 'ripide-api'
import type { OutputSelection } from './output.ts'
import { formatOutputPage, selectOutput } from './output.ts'

export function formatDoctorReport(report: DoctorReport, json = false): string {
  if (json)
    return JSON.stringify(report, null, 2)
  if (!report.findings.length)
    return `doctor: no findings across ${report.filesScanned} files\n`
  const byCheck = new Map<DoctorCheck, DoctorFinding[]>()
  for (const f of report.findings) {
    const arr = byCheck.get(f.check) ?? []
    arr.push(f)
    byCheck.set(f.check, arr)
  }
  const lines: string[] = []
  for (const [check, items] of byCheck) {
    lines.push(`# ${check} (${items.length})`)
    for (const it of items)
      lines.push(`  ${it.file}: ${it.message}`)
    lines.push('')
  }
  lines.push(`${report.findings.length} finding(s) across ${report.filesScanned} files`)
  return `${lines.join('\n')}\n`
}

export function selectDoctorFindings(report: DoctorReport, options: OutputSelection = { limit: 50 }) {
  const groups = new Map<string, DoctorFinding[]>()
  for (const finding of [...report.findings].sort((a, b) => a.check.localeCompare(b.check) || a.file.localeCompare(b.file) || a.message.localeCompare(b.message))) {
    const findings = groups.get(finding.check) ?? []
    findings.push(finding)
    groups.set(finding.check, findings)
  }
  // Round-robin checks before pagination. Every check gets a deterministic first detail.
  const ordered: DoctorFinding[] = []
  for (let index = 0; [...groups.values()].some(findings => index < findings.length); index++) {
    for (const findings of groups.values()) {
      if (findings[index])
        ordered.push(findings[index])
    }
  }
  return selectOutput(ordered, options, finding => finding.file)
}

export function formatAgentDoctorReport(report: DoctorReport, options: OutputSelection = { limit: 50 }): string {
  const page = selectDoctorFindings(report, options)
  const counts = new Map<DoctorCheck, number>()
  for (const f of report.findings)
    counts.set(f.check, (counts.get(f.check) ?? 0) + 1)
  const lines = [`findings: ${report.findings.length}/${report.filesScanned} files scanned`]
  for (const [check, n] of counts)
    lines.push(`  ${check}: ${n}`)
  for (const f of page.results)
    lines.push(`  ${f.check} ${f.file}: ${f.message}`)
  lines.push(formatOutputPage(page))
  if (page.omitted)
    lines.push('Retrieve more with --offset, --limit, --file, or --checks.')
  return lines.join('\n')
}
