import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Identity { pid: number, group: number, started: string, state: string }
function identity(pid: number): Identity | null {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
      return null
    throw error
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { pid, group: Number(fields[2]), started: fields[19], state: fields[0] }
}
export function groupMembers(group: number): Identity[] {
  if (process.platform !== 'linux')
    return []
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap((name) => {
    const found = identity(Number(name))
    return found && found.group === group && found.state !== 'Z' && found.state !== 'X' ? [found] : []
  })
}
export function createTraceTracker(directory: string, supervisor: number | undefined) {
  const supervisorIdentity = supervisor ? identity(supervisor) : null
  const owned = (pid: number) => {
    let status: string
    try {
      status = readFileSync(`/proc/${pid}/status`, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
        return false
      throw error
    }
    const currentSupervisor = supervisor ? identity(supervisor) : null
    return Boolean(supervisorIdentity && currentSupervisor?.started === supervisorIdentity.started && Number(/^TracerPid:\s+(\d+)/m.exec(status)?.[1]) === supervisor)
  }
  const tracked = new Map<number, Identity | null>()
  const terminal = (pid: number) => /\+\+\+ (?:exited with|killed by|detached)/.test(readFileSync(join(directory, `process.trace.${pid}`), 'utf8'))
  const collect = () => {
    if (!supervisor || !identity(supervisor))
      return
    for (const name of readdirSync(directory)) {
      const match = /^process\.trace\.(\d+)$/.exec(name)
      if (match && !tracked.has(Number(match[1])))
        tracked.set(Number(match[1]), terminal(Number(match[1])) || !owned(Number(match[1])) ? null : identity(Number(match[1])))
    }
  }
  const terminate = (signal: NodeJS.Signals) => {
    collect()
    const killed: number[] = []
    for (const [pid, recorded] of tracked) {
      if (terminal(pid) || !owned(pid))
        continue
      const current = identity(pid)
      if (!recorded || !current || recorded.started !== current.started || current.state === 'Z' || current.state === 'X')
        continue
      try {
        process.kill(pid, signal)
        killed.push(pid)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw error
      }
    }
    return killed
  }
  return { collect, terminate }
}
