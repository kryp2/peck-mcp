import { spawn } from 'node:child_process'

const proc = spawn('npx', ['tsx', 'src/mcp/peck-mcp.ts'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''; let nextId = 1
const pending = new Map<number, (m: any) => void>()
proc.stdout.on('data', c => {
  buf += c.toString()
  let nl: number
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    try { const m = JSON.parse(line); const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m) } } catch {}
  }
})
proc.stderr.on('data', c => process.stderr.write('[mcp] ' + c.toString()))

function req(method: string, params: any = {}) {
  const id = nextId++
  return new Promise<any>(resolve => {
    pending.set(id, resolve)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function main() {
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  await req('notifications/initialized', {})
  const r = await req('tools/call', { name: 'peck_marketplace_overview', arguments: {} })
  const text = r.result?.content?.[0]?.text ?? ''
  console.log('--- response ---')
  console.log(text)
  console.log('--- size ---')
  console.log('bytes:', text.length, '~tokens:', Math.round(text.length / 4))
  proc.kill()
}
main()
