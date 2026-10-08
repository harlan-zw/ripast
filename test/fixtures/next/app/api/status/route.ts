import { NextResponse } from 'next/server'
import { formatCount } from '@/lib/count'

export function GET() {
  return NextResponse.json({ label: formatCount(2) })
}
