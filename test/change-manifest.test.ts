import assert from 'node:assert/strict'
import { buildChangeManifest } from 'ripide-api'
import { it } from 'vitest'

it('manifest reports separate before and after ranges without unchanged context', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\n'
  const after = 'ONE\ntwo\nthree\nfour\nFIVE\nsix\n'
  assert.deepEqual(buildChangeManifest([{ rel: 'source.ts', before, after }]), {
    changes: [['source.ts', '1,5']],
  })
})

it('manifest represents insertions and deletions as gaps after a line', () => {
  assert.deepEqual(buildChangeManifest([{ rel: 'add.ts', before: 'a\n', after: 'a\nb\nc\n' }]), {
    changes: [['add.ts', '1+', '2-3']],
  })
  assert.deepEqual(buildChangeManifest([{ rel: 'delete.ts', before: 'a\nb\nc\n', after: 'a\n' }]), {
    changes: [['delete.ts', '2-3', '1+']],
  })
  assert.deepEqual(buildChangeManifest([{ rel: 'empty.ts', before: '', after: 'a\n' }]), {
    changes: [['empty.ts', '0+', '1']],
  })
})

it('manifest reports file moves separately and includes moved file edits', () => {
  assert.deepEqual(buildChangeManifest([], { from: 'old.ts', to: 'new.ts', before: 'a\n', after: 'a\n' }), {
    changes: [],
    moves: [['old.ts', 'new.ts']],
  })
  assert.deepEqual(buildChangeManifest([], { from: 'old.ts', to: 'new.ts', before: 'a\n', after: 'b\n' }), {
    changes: [['new.ts', '1']],
    moves: [['old.ts', 'new.ts']],
  })
})
