import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
writeFileSync('server.pid', String(process.pid))
// Refuse graceful shutdown so callers must enforce bounded termination.
process.on('SIGTERM', () => {})
setInterval(() => {}, 10_000)
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0)
      return
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + size)
      return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString())
    buffer = buffer.subarray(end + 4 + size)
    if (message.method === 'initialize' && !process.argv.includes('--stall-initialize')) {
      const result = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
      process.stdout.write(`Content-Length: ${Buffer.byteLength(result)}\r\n\r\n${result}`)
    }
    // Keep the transport alive but never answer semantic requests.
  }
})
