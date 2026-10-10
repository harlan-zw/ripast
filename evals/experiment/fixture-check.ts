import { join } from 'node:path'
import ts from 'typescript'

const project = process.argv[2]
const config = ts.readConfigFile(join(project, 'tsconfig.json'), ts.sys.readFile)
if (config.error)
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, ' '))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, project)
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: false, outDir: join(project, '.build') })
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => project, getCanonicalFileName: path => path, getNewLine: () => '\n' }))
  process.exitCode = 1
}
else {
  const emitted = program.emit()
  if (emitted.emitSkipped || emitted.diagnostics.length)
    process.exitCode = 1
  else
    console.log('Full installed fixture project typecheck and build passed.')
}
