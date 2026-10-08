import Link from 'next/link'
import { Counter } from '@/components/Counter'
import { formatCount } from '@/lib/count'

export default function Home() {
  return <main><h1>{formatCount(2)}</h1><Counter initialCount={2} /><Link href="/api/status">Status</Link></main>
}
