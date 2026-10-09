import type { DiagnosticCheck, Regression, Verification } from 'ripide-api'
import { relative } from 'node:path'

export type CompactDiagnosticCheck = [checker: DiagnosticCheck['checker'], scope: DiagnosticCheck['scope'], files: number, newErrors: number, ignoredErrors?: number]

export function compactVerification(verification: Verification): CompactDiagnosticCheck[] | Extract<Verification, { _tag: 'Skipped' }>['reason'] {
  if (verification._tag === 'Skipped')
    return verification.reason
  return verification.checks.map(({ checker, scope, files, newErrors, ignoredErrors }) => ignoredErrors
    ? [checker, scope, files, newErrors, ignoredErrors]
    : [checker, scope, files, newErrors])
}

export function formatVerification(verification: Verification): string {
  if (verification._tag === 'Skipped')
    return `verification: skipped (${verification.reason})`
  return verification.checks.map(check => `${check.checker} diagnostics: ${check.scope}, ${check.files} files, ${check.newErrors} new errors${check.ignoredErrors ? `, ${check.ignoredErrors} ignored errors` : ''}`).join('\n')
}

export function formatRegressions(regressions: Regression[], cwd: string): string {
  const lines = [`${regressions.length} new type diagnostic${regressions.length === 1 ? '' : 's'} introduced:`]
  for (const r of regressions) {
    lines.push(`  ${relative(cwd, r.file)}:${r.line}:${r.col} TS${r.code} ${r.message}`)
  }
  return lines.join('\n')
}
