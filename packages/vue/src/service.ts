import type { LanguageService, LanguageServiceEnvironment, ProjectContext } from '@volar/language-service'
import type { TypeScriptProjectHost } from '@volar/typescript'
import type { FileChange, TextEdit } from 'ripide-api/adapter'
import type { WorkspaceEdit } from 'vscode-languageserver-protocol'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import ts from '@typescript/typescript6'
import { createLanguage, createLanguageService, createUriMap, FileType } from '@volar/language-service'
import { createLanguageServiceHost, resolveFileLanguageId } from '@volar/typescript'
import { createParsedCommandLine, createVueLanguagePlugin, getAllExtensions } from '@vue/language-core'
import { createVueLanguageServicePlugins } from '@vue/language-service'
import { applyTextEdits, offsetOfPosition } from 'ripide-api/adapter'
import { create as createTypeScriptServicePlugins } from 'volar-service-typescript'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'

export interface VueService {
  service: LanguageService
  fileToUri: (fileName: string) => URI
  uriToFile: (uri: URI) => string
  read: (fileName: string) => string | undefined
  setSnapshot: (fileName: string, text: string) => void
  dispose: () => void
}

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error)
    return arg.message
  if (typeof arg === 'string')
    return arg
  return String(arg)
}

function isNoisyDiagnostic(text: string): boolean {
  return text.includes('languageId not found') || text.includes('.d.ts.map') || text.includes('.d.mts.map') || text.includes('.d.cts.map')
}

/**
 * Run `fn` with `console.warn` muted for messages we know are unactionable:
 * - "[Vue] Resolve plugin path failed" / "[Vue] Load plugin failed" from @vue/language-core
 *   when a vueCompilerOptions.plugins entry isn't installable (common with Nuxt 4 + vue-router 4.6+).
 * Everything else passes through unchanged.
 */
export function withFilteredConsoleWarn<T>(fn: () => T): T {
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (first.startsWith('[Vue] Resolve plugin path failed') || first.startsWith('[Vue] Load plugin failed'))
      return
    if (first.startsWith('languageId not found'))
      return
    original.apply(console, args as Parameters<typeof console.warn>)
  }
  const restore = (): void => {
    console.warn = original
  }
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      return (result as any).then((v: T) => {
        restore()
        return v
      }, (e: unknown) => {
        restore()
        throw e
      })
    }
    restore()
    return result
  }
  catch (err) {
    restore()
    throw err
  }
}

export function createVueService(tsconfigPath: string, cwd: string): VueService {
  const restore = installFilteredConsoleWarn()
  const service = createVueServiceInternal(tsconfigPath, cwd)
  const origDispose = service.dispose
  service.dispose = () => {
    try {
      origDispose()
    }
    finally {
      restore()
    }
  }
  return service
}

function installFilteredConsoleWarn(): () => void {
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (first.startsWith('[Vue] Resolve plugin path failed') || first.startsWith('[Vue] Load plugin failed'))
      return
    if (first.startsWith('languageId not found'))
      return
    original.apply(console, args as Parameters<typeof console.warn>)
  }
  return () => {
    console.warn = original
  }
}

function readVueProject(tsconfigPath: string) {
  const commandLine = createParsedCommandLine(ts, ts.sys, tsconfigPath)
  // createParsedCommandLine doesn't add .vue files because it doesn't pass extraFileExtensions.
  // Reparse with the right extensions so commandLine.fileNames includes .vue.
  const vueExts = getAllExtensions(commandLine.vueOptions).map((ext) => {
    const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext
    return { extension: cleanExt, isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }
  })
  const reparsed = ts.parseJsonSourceFileConfigFileContent(
    ts.readJsonConfigFile(tsconfigPath, ts.sys.readFile),
    ts.sys,
    resolve(tsconfigPath, '..'),
    undefined,
    tsconfigPath,
    undefined,
    vueExts,
  )
  const fileNames = reparsed.fileNames
  if (commandLine.options.allowNonTsExtensions === undefined)
    commandLine.options.allowNonTsExtensions = true
  return { commandLine, fileNames }
}

export function vueProjectConfigs(tsconfigPath: string): { tsconfigPath: string, files: string[] }[] {
  const projects: { tsconfigPath: string, files: string[] }[] = []
  const seen = new Set<string>()
  const visit = (path: string): void => {
    path = resolve(path)
    if (existsSync(path) && statSync(path).isDirectory())
      path = resolve(path, 'tsconfig.json')
    if (seen.has(path))
      return
    seen.add(path)
    if (!existsSync(path))
      throw new Error(`ripide: cannot inspect the referenced Vue project ${path}`)
    const { commandLine, fileNames } = withFilteredConsoleWarn(() => readVueProject(path))
    // Each project retains its own compiler options and path aliases.
    if (fileNames.length || !commandLine.projectReferences?.length)
      projects.push({ tsconfigPath: path, files: fileNames })
    for (const reference of commandLine.projectReferences ?? [])
      visit(reference.path)
  }
  visit(tsconfigPath)
  return projects
}

function createVueServiceInternal(tsconfigPath: string, cwd: string): VueService {
  const { commandLine, fileNames } = readVueProject(tsconfigPath)
  // URI.fsPath lowercases Windows drive letters. Rebase keys onto the caller's cwd.
  const normalizeFileName = (file: string): string => resolve(cwd, relative(cwd, resolve(cwd, file)))
  const overlays = new Map<string, string>()
  const roots = new Set(fileNames.map(file => resolve(cwd, file)))
  const overlayDirectories = new Set<string>()
  const sys: ts.System = {
    ...ts.sys,
    fileExists: file => overlays.has(normalizeFileName(file)) || ts.sys.fileExists(file),
    readFile: file => overlays.get(normalizeFileName(file)) ?? ts.sys.readFile(file),
    directoryExists: directory => overlayDirectories.has(normalizeFileName(directory)) || ts.sys.directoryExists(directory),
  }

  const fileToUri = (fileName: string): URI => URI.file(resolve(cwd, fileName))
  const uriToFile = (uri: URI): string => normalizeFileName(uri.fsPath)
  const uriToTsFile = (uri: URI): string => uriToFile(uri).replace(/\\/g, '/')

  const language = createLanguage<URI>(
    [
      createVueLanguagePlugin<URI>(
        ts,
        commandLine.options,
        commandLine.vueOptions,
        uriToTsFile,
      ),
      { getLanguageId: uri => resolveFileLanguageId(uri.path) },
    ],
    createUriMap(ts.sys.useCaseSensitiveFileNames),
    (uri, includeFsFiles) => {
      if (!includeFsFiles)
        return
      const fileName = uriToFile(uri)
      const text = sys.readFile(fileName)
      if (text !== undefined) {
        language.scripts.set(uri, ts.ScriptSnapshot.fromString(text))
      }
      else {
        language.scripts.delete(uri)
      }
    },
  )

  let projectVersion = 0
  const projectHost: TypeScriptProjectHost = {
    getCurrentDirectory: () => cwd.replace(/\\/g, '/'),
    getCompilationSettings: () => commandLine.options,
    getProjectReferences: () => commandLine.projectReferences,
    getScriptFileNames: () => [...roots].map(file => file.replace(/\\/g, '/')),
    getProjectVersion: () => String(projectVersion),
  }

  const env: LanguageServiceEnvironment = {
    workspaceFolders: [URI.file(cwd)],
    fs: {
      stat(uri) {
        if (uri.scheme !== 'file')
          return undefined
        const overlay = overlays.get(uriToFile(uri))
        if (overlay !== undefined)
          return { type: FileType.File, ctime: 0, mtime: projectVersion, size: overlay.length }
        try {
          const s = statSync(uri.fsPath)
          return {
            type: s.isFile() ? FileType.File : s.isDirectory() ? FileType.Directory : s.isSymbolicLink() ? FileType.SymbolicLink : FileType.Unknown,
            ctime: s.ctimeMs,
            mtime: s.mtimeMs,
            size: s.size,
          }
        }
        catch {
          return undefined
        }
      },
      readFile(uri) {
        if (uri.scheme !== 'file')
          return undefined
        const overlay = overlays.get(uriToFile(uri))
        if (overlay !== undefined)
          return overlay
        try {
          return readFileSync(uri.fsPath, 'utf8')
        }
        catch {
          return undefined
        }
      },
      readDirectory() { return [] },
    },
    console: {
      log() {},
      warn() {},
      info() {},
      error(...args: unknown[]) {
        const text = args.map(stringifyArg).join(' ')
        if (isNoisyDiagnostic(text))
          return
        process.stderr.write(`${text}\n`)
      },
    } as any,
  }

  const project: ProjectContext = {
    typescript: {
      configFileName: tsconfigPath.replace(/\\/g, '/'),
      sys,
      uriConverter: { asFileName: uriToTsFile, asUri: fileToUri },
      ...createLanguageServiceHost(ts, sys, language, fileToUri, projectHost),
    },
  }

  const plugins = [
    ...createTypeScriptServicePlugins(ts),
    ...createVueLanguageServicePlugins(ts),
  ]
  const service = createLanguageService(language, plugins, env, project)

  return {
    service,
    fileToUri,
    uriToFile,
    read: (fileName: string) => {
      try {
        return readFileSync(fileName, 'utf8')
      }
      catch {
        return undefined
      }
    },
    setSnapshot: (fileName: string, text: string) => {
      const path = normalizeFileName(fileName)
      overlays.set(path, text)
      if (path.endsWith('.vue'))
        roots.add(path)
      for (let directory = dirname(path); !overlayDirectories.has(directory); directory = dirname(directory)) {
        overlayDirectories.add(directory)
        if (dirname(directory) === directory)
          break
      }
      language.scripts.set(URI.file(path), ts.ScriptSnapshot.fromString(text))
      projectVersion++
    },
    dispose: () => service.dispose(),
  }
}

export function workspaceEditToChanges(
  edit: WorkspaceEdit,
  vue: VueService,
  cwd: string,
  filter?: (fileName: string) => boolean,
  transformEdits?: (path: string, source: string, edits: TextEdit[]) => TextEdit[],
): FileChange[] {
  const out: FileChange[] = []
  const seen = new Set<string>()
  const apply = (uriStr: string, edits: { range: { start: { line: number, character: number }, end: { line: number, character: number } }, newText: string }[]) => {
    const uri = URI.parse(uriStr)
    const fileName = vue.uriToFile(uri)
    if (filter && !filter(fileName))
      return
    if (seen.has(fileName))
      return
    seen.add(fileName)
    const before = vue.read(fileName)
    if (before === undefined)
      return
    const doc = TextDocument.create(uriStr, 'plaintext', 0, before)
    const after = transformEdits
      ? applyTextEdits(before, transformEdits(fileName, before, edits.map(edit => ({
          start: offsetOfPosition(before, edit.range.start),
          end: offsetOfPosition(before, edit.range.end),
          replacement: edit.newText,
        }))))
      : TextDocument.applyEdits(doc, edits as any)
    if (after === before)
      return
    out.push({
      path: fileName,
      rel: workspaceRelativePath(fileName, cwd),
      before,
      after,
    })
  }
  if (edit.changes) {
    for (const [uriStr, edits] of Object.entries(edit.changes)) {
      apply(uriStr, edits as any)
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change && 'edits' in change) {
        apply(change.textDocument.uri, change.edits as any)
      }
    }
  }
  return out
}

export function workspaceRelativePath(fileName: string, cwd: string): string {
  const rel = relative(cwd, fileName)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : fileName
}
