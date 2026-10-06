import type { Ignore } from 'ignore'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import ignore from 'ignore'
import picomatch from 'picomatch'

export type FileSearch = { _tag: 'Files' } | { _tag: 'Text', patterns: string[] }
interface IgnoreLayer { root: string, priority: number, matcher: Ignore }

const normalize = (path: string): string => path.split(sep).join('/')

function addIgnoreFile(layers: IgnoreLayer[], root: string, file: string, priority: number): IgnoreLayer[] {
  if (!existsSync(file))
    return layers
  return [...layers, { root, priority, matcher: ignore({ ignorecase: false }).add(readFileSync(file, 'utf8')) }]
}

function directoryLayers(layers: IgnoreLayer[], directory: string, gitRoot: string | undefined): IgnoreLayer[] {
  let next = layers
  const fromGitRoot = gitRoot ? relative(gitRoot, directory) : undefined
  if (fromGitRoot !== undefined && fromGitRoot !== '..' && !fromGitRoot.startsWith(`..${sep}`))
    next = addIgnoreFile(next, directory, join(directory, '.gitignore'), 2)
  next = addIgnoreFile(next, directory, join(directory, '.ignore'), 3)
  return addIgnoreFile(next, directory, join(directory, '.rgignore'), 4)
}

function isIgnored(path: string, directory: boolean, layers: IgnoreLayer[]): boolean {
  let ignored = false
  for (const layer of [...layers].sort((a, b) => a.priority - b.priority)) {
    const rel = normalize(relative(layer.root, path))
    if (!rel || rel.startsWith('../'))
      continue
    const result = layer.matcher.test(`${rel}${directory ? '/' : ''}`)
    if (result.ignored || result.unignored)
      ignored = result.ignored
  }
  return ignored
}

// Global excludes apply relative to the repository root, not the config directory.
function globalExcludes(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const configFiles = [process.env.GIT_CONFIG_GLOBAL, join(homedir(), '.gitconfig'), join(configHome, 'git', 'config'), process.env.GIT_CONFIG_SYSTEM || '/etc/gitconfig'].filter((path): path is string => !!path)
  for (const file of configFiles) {
    if (!existsSync(file))
      continue
    let section = ''
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const header = line.match(/^\s*\[([^\]]+)\]/)
      if (header)
        section = header[1].toLowerCase()
      const setting = line.trim().match(/^excludesfile\s*=(.*)$/i)
      if (section === 'core' && setting) {
        const value = setting[1].trim().replace(/^"|"$/g, '')
        return value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(dirname(file), value)
      }
    }
  }
  return join(configHome, 'git', 'ignore')
}

export function searchFiles(cwd: string, globs: string[], search: FileSearch): string[] {
  const root = resolve(cwd)
  if (!statSync(root).isDirectory())
    throw new Error(`Search directory is not a directory: ${root}`)
  const ancestors: string[] = []
  for (let directory = root; ; directory = dirname(directory)) {
    ancestors.unshift(directory)
    if (dirname(directory) === directory)
      break
  }
  const gitRoot = [...ancestors].reverse().find(directory => existsSync(join(directory, '.git')))
  const gitLayers = (repository: string): IgnoreLayer[] => {
    const layers = addIgnoreFile([], repository, globalExcludes(), 0)
    const gitPath = join(repository, '.git')
    const gitDirectory = statSync(gitPath).isDirectory()
      ? gitPath
      : resolve(repository, readFileSync(gitPath, 'utf8').replace(/^gitdir:\s*/, '').trim())
    const commonPath = join(gitDirectory, 'commondir')
    const commonDirectory = existsSync(commonPath) ? resolve(gitDirectory, readFileSync(commonPath, 'utf8').trim()) : gitDirectory
    return addIgnoreFile(layers, repository, join(commonDirectory, 'info', 'exclude'), 1)
  }
  let initial: IgnoreLayer[] = gitRoot ? gitLayers(gitRoot) : []
  for (const directory of ancestors.slice(0, -1))
    initial = directoryLayers(initial, directory, gitRoot)

  const rules = globs.map((glob) => {
    const excluded = glob.startsWith('!')
    let pattern = excluded ? glob.slice(1) : glob
    // ripgrep treats braces as alternatives, including a single literal alternative.
    for (;;) {
      const next = pattern.replace(/(?<!\\)\{([^{}]*)\}/g, (match, body: string) => body.includes(',') ? match : body)
      if (next === pattern)
        break
      pattern = next
    }
    return { excluded, matches: picomatch(pattern.replace(/^\//, ''), { dot: true, nonegate: true, noext: true, strictSlashes: true, basename: !pattern.includes('/') }) }
  })
  const hasIncludes = rules.some(rule => !rule.excluded)
  const results: string[] = []
  const walk = (directory: string, inherited: IgnoreLayer[], repository: string | undefined): void => {
    const nestedRepository = directory !== repository && existsSync(join(directory, '.git'))
    const currentRepository = nestedRepository ? directory : repository
    const currentLayers = nestedRepository ? [...gitLayers(directory), ...inherited.filter(layer => layer.priority > 2)] : inherited
    const layers = directoryLayers(currentLayers, directory, currentRepository)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink())
        continue
      const path = join(directory, entry.name)
      const isDirectory = entry.isDirectory()
      if (!isDirectory && !entry.isFile())
        continue
      const rel = normalize(relative(root, path))
      let selection: 'Include' | 'Exclude' | 'Unspecified' = 'Unspecified'
      for (const rule of rules) {
        if (rule.matches(rel) || (isDirectory && rule.excluded && rule.matches(`${rel}/`)))
          selection = rule.excluded ? 'Exclude' : 'Include'
      }
      if (selection === 'Exclude' || (selection !== 'Include' && isIgnored(path, isDirectory, layers)))
        continue
      if (isDirectory) {
        walk(path, layers, currentRepository)
        continue
      }
      if (selection === 'Unspecified' && hasIncludes)
        continue
      if (search._tag === 'Files') {
        results.push(path)
        continue
      }
      const content = readFileSync(path)
      if (!content.includes(0) && search.patterns.some(pattern => content.includes(pattern)))
        results.push(path)
    }
  }
  walk(root, initial, gitRoot)
  return results
}
