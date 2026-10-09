import type { LspDiagnostic } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { diffChars } from 'diff'
import { offsetOfPosition } from './ts-server.ts'

/** Match only diagnostics whose source range survives the proposed edits. */
export function diagnosticRegressions(
  before: ReadonlyMap<string, readonly LspDiagnostic[]>,
  after: ReadonlyMap<string, readonly LspDiagnostic[]>,
  changes: readonly Pick<FileChange, 'path' | 'before' | 'after'>[],
): Regression[] {
  const changed = new Map(changes.map(change => [change.path, change]))
  const out: Regression[] = []
  for (const [path, diagnostics] of after) {
    const change = changed.get(path)
    const baseline = new Map<string, number>()
    const spans = change && change.before !== change.after ? unchangedSpans(change.before, change.after) : null
    for (const diagnostic of before.get(path) ?? []) {
      const range = baselineRange(diagnostic, change, spans)
      if (!range)
        continue
      const key = diagnosticKey(diagnostic, range)
      baseline.set(key, (baseline.get(key) ?? 0) + 1)
    }
    for (const diagnostic of diagnostics) {
      const range = change
        ? {
            start: offsetOfPosition(change.after, diagnostic.range.start),
            end: offsetOfPosition(change.after, diagnostic.range.end),
          }
        : diagnostic.range
      const key = diagnosticKey(diagnostic, range)
      const remaining = baseline.get(key) ?? 0
      if (remaining) {
        baseline.set(key, remaining - 1)
        continue
      }
      out.push({
        file: path,
        line: diagnostic.range.start.line + 1,
        col: diagnostic.range.start.character + 1,
        code: typeof diagnostic.code === 'number' ? diagnostic.code : Number(diagnostic.code) || 0,
        message: diagnostic.message,
      })
    }
  }
  return out
}

interface UnchangedSpan { before: number, after: number, length: number }

function baselineRange(
  diagnostic: LspDiagnostic,
  change: Pick<FileChange, 'before' | 'after'> | undefined,
  spans: UnchangedSpan[] | null,
): LspDiagnostic['range'] | { start: number, end: number } | null {
  if (!change)
    return diagnostic.range
  if (change.before === change.after) {
    return {
      start: offsetOfPosition(change.before, diagnostic.range.start),
      end: offsetOfPosition(change.before, diagnostic.range.end),
    }
  }
  return spans ? mappedRange(diagnostic, change.before, change.after, spans) : null
}

function unchangedSpans(before: string, after: string): UnchangedSpan[] | null {
  // If diffing exceeds the budget, retain no baseline matches.
  const parts = diffChars(before, after, { timeout: 250 })
  if (!parts)
    return null
  const spans: UnchangedSpan[] = []
  let beforeOffset = 0
  let afterOffset = 0
  for (const part of parts) {
    if (!part.added && !part.removed)
      spans.push({ before: beforeOffset, after: afterOffset, length: part.value.length })
    if (!part.added)
      beforeOffset += part.value.length
    if (!part.removed)
      afterOffset += part.value.length
  }
  return spans
}

function mappedRange(diagnostic: LspDiagnostic, before: string, after: string, spans: UnchangedSpan[]): { start: number, end: number } | null {
  const start = offsetOfPosition(before, diagnostic.range.start)
  const end = offsetOfPosition(before, diagnostic.range.end)
  const span = spans.find(span => start >= span.before && start < span.before + span.length && end <= span.before + span.length)
  if (span) {
    const shift = span.after - span.before
    return { start: start + shift, end: end + shift }
  }
  // Identifier renames can retain the same error at the same anchored site.
  // Require unchanged text on both sides. Do not match removed expressions.
  const left = spans.find(span => start > span.before && start <= span.before + span.length)
  const right = spans.find(span => end >= span.before && end < span.before + span.length)
  if (!left || !right)
    return null
  const mappedStart = start + left.after - left.before
  const mappedEnd = end + right.after - right.before
  if (!isIdentifier(before.slice(start, end)) || !isIdentifier(after.slice(mappedStart, mappedEnd)))
    return null
  return { start: mappedStart, end: mappedEnd }
}

function isIdentifier(text: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(text)
}

function diagnosticKey(diagnostic: LspDiagnostic, range: LspDiagnostic['range'] | { start: number, end: number }): string {
  return JSON.stringify([diagnostic.code ?? '', diagnostic.message, range.start, range.end])
}
