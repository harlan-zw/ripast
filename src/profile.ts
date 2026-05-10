import { performance } from 'node:perf_hooks'

export interface ProfileEvent {
  phase: string
  ms: number
}

export type ProfileSink = (event: ProfileEvent) => void

export function timed<T>(profile: ProfileSink | undefined, phase: string, fn: () => T): T {
  if (!profile)
    return fn()
  const start = performance.now()
  try {
    return fn()
  }
  finally {
    profile({ phase, ms: performance.now() - start })
  }
}

export async function timedAsync<T>(profile: ProfileSink | undefined, phase: string, fn: () => Promise<T>): Promise<T> {
  if (!profile)
    return fn()
  const start = performance.now()
  try {
    return await fn()
  }
  finally {
    profile({ phase, ms: performance.now() - start })
  }
}
