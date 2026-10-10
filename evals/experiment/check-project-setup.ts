import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [project, provenance, task] = process.argv.slice(2)
const rows = JSON.parse(readFileSync(provenance, 'utf8')) as { scenario: { id: string, file: string }, capture: { files: Record<string, string> } }[]
const selected = rows.find(row => row.scenario.id === task)
if (!selected)
  throw new Error('Choose a registered check case.')
writeFileSync(join(project, selected.scenario.file), selected.capture.files[selected.scenario.file])
execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--only', '-m', 'chore: seed eval bug', '--', selected.scenario.file], { cwd: project, env: { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } })
