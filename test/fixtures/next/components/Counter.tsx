'use client'

import { useState } from 'react'
import { formatCount } from '@/lib/count'

export function Counter({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount)
  return <button className="rounded p-2" onClick={() => setCount(count + 1)}>{formatCount(count)}</button>
}
