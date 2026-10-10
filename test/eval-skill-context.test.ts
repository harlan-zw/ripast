import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadSkillContext, prepareSkillContext } from '../evals/skill-context.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture(entry: string) {
  const root = mkdtempSync(join(tmpdir(), 'ripide-skill-context-'))
  roots.push(root)
  mkdirSync(join(root, 'skill'))
  writeFileSync(join(root, 'skill', 'CUSTOM.md'), entry)
  return join(root, 'skill', 'CUSTOM.md')
}

it('refuses an unavailable local reference before model dispatch', () => {
  const entry = fixture('Read [commands](references/commands.md).\n')
  const result = loadSkillContext(entry)
  expect(result).toMatchObject({ _tag: 'Err', reason: 'missing-resource' })
})

it('copies nested references and exact instruction bytes into the allowed project', () => {
  const source = '---\nname: custom\n---\nRead [commands](references/commands.md). [source](https://example.com/source).\n'
  const entry = fixture(source)
  const root = join(entry, '..')
  mkdirSync(join(root, 'references'))
  const commands = '[verification][check]\n[check]: verify%20mode.md#scope\n'
  const verification = 'Nested bytes.\r\n[entry](../CUSTOM.md)\r\n'
  writeFileSync(join(root, 'references', 'commands.md'), commands)
  writeFileSync(join(root, 'references', 'verify mode.md'), verification)
  const project = join(root, '..', 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'protected.txt'), 'preserve')
  const loaded = loadSkillContext(entry)
  if (loaded._tag === 'Err')
    throw new Error(loaded.message)
  const prepared = prepareSkillContext(loaded.value, project)
  expect(prepared.prompt).toContain(`already loaded. Do not reopen its entry file.`)
  expect(prepared.prompt.split('<skill>\n')[1]?.split('\n</skill>')[0]).toBe(source)
  expect(prepared.base).toBe(join(project, '.ripide-eval-skill'))
  expect(readFileSync(join(prepared.base, 'references', 'verify mode.md'), 'utf8')).toBe(verification)
  expect(readFileSync(join(prepared.base, 'references', 'commands.md'), 'utf8')).toBe(commands)
  expect(readFileSync(join(project, 'protected.txt'), 'utf8')).toBe('preserve')
  expect(prepared.metadata.resources.find(r => r.path === 'references/verify mode.md')?.sha256).toBe(createHash('sha256').update(verification).digest('hex'))
  expect(prepared.metadata.externalReferences).toEqual(['https://example.com/source'])
  expect(existsSync(join(prepared.base, 'source'))).toBe(false)
})

it.each(['../outside.md', '%2e%2e/outside.md', '/etc/passwd', 'file:///etc/passwd', '%2Fetc/passwd'])('refuses a reference outside the supplied base: %s', (target) => {
  const entry = fixture(`[escape](${target})\n`)
  expect(loadSkillContext(entry)).toMatchObject({ _tag: 'Err', reason: 'escapes-root' })
})

it('refuses symlink resources, including links to files inside the base', () => {
  const entry = fixture('[linked](linked.md)\n')
  writeFileSync(join(entry, '..', 'real.md'), 'content')
  symlinkSync('real.md', join(entry, '..', 'linked.md'))
  expect(loadSkillContext(entry)).toMatchObject({ _tag: 'Err', reason: 'symlink' })
})

it('does not interpret fenced or inline code examples as local resources', () => {
  const entry = fixture('```md\n[example](missing.md)\n```\n`[example](missing.md)`\n')
  const result = loadSkillContext(entry)
  expect(result._tag).toBe('Ok')
  if (result._tag === 'Err')
    throw new Error(result.message)
  const project = join(entry, '..', '..', 'project')
  mkdirSync(project)
  expect(prepareSkillContext(result.value, project).metadata.resources.map(r => r.path)).toEqual(['CUSTOM.md'])
})

it('refuses malformed local link paths', () => {
  const entry = fixture('[broken](missing%GG.md)\n')
  expect(loadSkillContext(entry)).toMatchObject({ _tag: 'Err', reason: 'invalid-link' })
})

it('resolves references from a custom entry without a Markdown extension', () => {
  const entry = fixture('unused')
  const custom = join(entry, '..', 'custom-skill.txt')
  writeFileSync(custom, '[local](commands.md "command title")\n')
  writeFileSync(join(entry, '..', 'commands.md'), 'local commands\n')
  const result = loadSkillContext(custom)
  if (result._tag === 'Err')
    throw new Error(result.message)
  const project = join(entry, '..', '..', 'project')
  mkdirSync(project)
  const context = prepareSkillContext(result.value, project)
  expect(readFileSync(join(context.base, 'commands.md'), 'utf8')).toBe('local commands\n')
  expect(context.metadata.entryPath).toBe('custom-skill.txt')
})

it('refuses a symlink directory before reading its resources', () => {
  const entry = fixture('[commands](linked/commands.md)\n')
  mkdirSync(join(entry, '..', '..', 'outside'))
  writeFileSync(join(entry, '..', '..', 'outside', 'commands.md'), 'outside')
  symlinkSync('../outside', join(entry, '..', 'linked'))
  expect(loadSkillContext(entry)).toMatchObject({ _tag: 'Err', reason: 'symlink' })
})
