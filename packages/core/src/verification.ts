import type { VerifyMode } from './project.ts'

export interface DiagnosticSummary {
  files: number
  newErrors: number
}

export interface DiagnosticCheck extends DiagnosticSummary {
  checker: string
  scope: 'touched' | 'project'
  /** Diagnostics excluded while verifying a planned file move. */
  ignoredErrors?: number
}

export type Verification
  = | { _tag: 'Checked', checks: [DiagnosticCheck, ...DiagnosticCheck[]] }
    | { _tag: 'Skipped', reason: 'disabled' | 'no-changes' | 'not-applicable' }

export type DiagnosticRecorder = (summary: DiagnosticSummary) => void

/** A receipt records completed checks. Requested options cannot produce success. */
export function createVerification(verifyMode: VerifyMode, hasChanges: boolean) {
  const checks: DiagnosticCheck[] = []
  const record = (checker: DiagnosticCheck['checker'], scope: DiagnosticCheck['scope']): DiagnosticRecorder => (summary) => {
    if (summary.files)
      checks.push({ checker, scope, ...summary })
  }
  return {
    typescript: record('typescript', verifyMode === 'project' ? 'project' : 'touched'),
    // The Vue adapter checks every configured Vue file, including unchanged consumers.
    vue: record('vue', 'project'),
    extension: (name: string) => record(name, 'project'),
    ignore(checker: DiagnosticCheck['checker'], count: number) {
      const check = checks.slice().reverse().find(check => check.checker === checker)
      if (check && count) {
        check.newErrors -= count
        check.ignoredErrors = (check.ignoredErrors ?? 0) + count
      }
    },
    result(): Verification {
      const [first, ...rest] = checks
      if (first)
        return { _tag: 'Checked', checks: [first, ...rest] }
      return { _tag: 'Skipped', reason: verifyMode === 'none' ? 'disabled' : hasChanges ? 'not-applicable' : 'no-changes' }
    },
  }
}
