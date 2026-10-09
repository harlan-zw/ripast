import type { ProfileEvent } from 'ripide-api'
import { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, runDelete, runRenameFile, runReplace, scan } from 'ripide-api'
import { expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each(['scan', 'tree', 'graph', 'unused', 'delete', 'replace', 'rename-file'])('reports %s operation phase costs without source payloads', async (operation) => {
  const fx = makeFixture({
    'source.ts': 'export const target = 1\nexport const next = 2\nexport const confidentialSourceCanary = 3',
    'consumer.ts': 'import { target } from \'./source\'\nconsole.log(target)',
  })
  const events: ProfileEvent[] = []
  const options = { cwd: fx.dir, verifyMode: 'none' as const, profile: (event: ProfileEvent) => events.push(event) }
  try {
    if (operation === 'scan') {
      expect(scan('target', options).length).toBeGreaterThan(0)
    }
    else if (operation === 'tree') {
      expect(buildDeclarationTree(options).files.length).toBeGreaterThan(0)
    }
    else if (operation === 'graph') {
      expect(buildScanGraph('target', options).nodes.length).toBeGreaterThan(0)
    }
    else if (operation === 'unused') {
      expect((await buildUnusedDeclarations({ ...options, exports: 'all' })).files.length).toBeGreaterThan(0)
    }
    else {
      const result = operation === 'delete'
        ? await runDelete('confidentialSourceCanary', 'source.ts', options)
        : operation === 'replace'
          ? await runReplace('target', 'next', options)
          : await runRenameFile('source.ts', 'destination.ts', options)
      expect(result.changes.length).toBeGreaterThan(0)
    }
    expect(events.length).toBeGreaterThan(0)
    if (operation === 'scan' || operation === 'graph' || operation === 'unused')
      expect(events.map(event => event.phase)).toContain(`${operation} parse`)
    expect(events.every(event => Number.isFinite(event.ms) && event.ms >= 0)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('confidentialSourceCanary')
  }
  finally {
    fx.cleanup()
  }
})
