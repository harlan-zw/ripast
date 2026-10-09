import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { runCssClassRename, runCssClassScan } from 'ripide-api'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cases = [
  { token: 'content-["a]:b["]', literal: JSON.stringify('content-["a]:b["]') },
  { token: String.raw`content-[\]]`, literal: JSON.stringify(String.raw`content-[\]]`) },
  { token: 'old-token', literal: String.raw`'\u006fld-token'` },
  { token: 'old-token', literal: String.raw`'\x6fld-token'` },
]

describe('encoded class key discovery', () => {
  it.each(cases)('discovers $literal through the SDK in JavaScript and Vue scripts', async ({ token, literal }) => {
    const source = `export const cls = ${literal}`
    const fx = makeFixture({
      'classes.js': source,
      'Page.vue': `<script>${source}</script><template><div /></template>`,
    }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token, count: 2, files: ['Page.vue', 'classes.js'] }])
      const result = await runCssClassRename(new Map([[token, 'new-token']]), { cwd: fx.dir })
      expect(result.changes.map(c => c.rel).sort()).toEqual(['Page.vue', 'classes.js'])
      for (const change of result.changes) {
        const script = change.rel.endsWith('.vue') ? change.after.match(/<script>([\s\S]*)<\/script>/)![1] : change.after
        const output = await import(`data:text/javascript,${encodeURIComponent(script)}`)
        expect(output.cls).toBe('new-token')
        expect(fx.read(change.rel)).toBe(change.before)
      }
    }
    finally { fx.cleanup() }
  })

  it.each(cases)('applies $literal through the CLI and leaves unrelated escaped text intact', ({ token, literal }) => {
    const fx = makeFixture({ 'classes.js': `export const cls = ${literal}\nexport const message = ${literal}` }, false)
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'css-class-rename',
        token,
        'new-token',
        '--apply',
        '--profile',
        'full',
        '--json',
      ], { cwd: fx.dir, encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).changes.map((change: { path: string }) => change.path)).toEqual(['classes.js'])
      const output = spawnSync(process.execPath, ['--input-type=module', '-e', `${fx.read('classes.js')}\nconsole.log(JSON.stringify({ cls, message }))`], { encoding: 'utf8' })
      expect(output.status).toBe(0)
      expect(JSON.parse(output.stdout)).toEqual({ cls: 'new-token', message: token })
    }
    finally { fx.cleanup() }
  })
})
