import { describe, expect, it } from 'vitest'
import { renameIdentifiers, renameStaticClasses } from '../evals/project-cases.ts'

describe('project eval expectations', () => {
  it('renames identifiers while preserving comments and literal strings', () => {
    const source = 'export function oldName() { return "oldName" }\n// oldName\noldName()'
    expect(renameIdentifiers(source, 'oldName', 'newName')).toBe('export function newName() { return "oldName" }\n// oldName\nnewName()')
  })

  it('renames complete static class tokens while preserving prose and prefixes', () => {
    const source = '<template><p class="font-bold hover:font-bold font-boldish">font-bold</p></template>'
    expect(renameStaticClasses(source, 'font-bold', 'font-medium')).toBe('<template><p class="font-medium hover:font-medium font-boldish">font-bold</p></template>')
  })
})
