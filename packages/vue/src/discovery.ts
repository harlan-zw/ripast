import { scan as coreScan, rgFiles as files, rgFilesMany as many } from '@ripast/core/adapter'
import { parseSourceFile } from './parse.ts'
import { extractTemplateExpressions } from './vue-template.ts'

const parser = { name: 'vue', suffixes: ['.vue'], parse: parseSourceFile, extractTemplateExpressions }
export const rgFiles: typeof files = (pattern, opts) => files(pattern, { ...opts, extensions: [parser] })
export const rgFilesMany: typeof many = (patterns, opts) => many(patterns, { ...opts, extensions: [parser] })
export const scan: typeof coreScan = (pattern, opts) => coreScan(pattern, { ...opts, extensions: [parser] })
