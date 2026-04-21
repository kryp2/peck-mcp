/**
 * test-mcp-withdraw.ts — exercise peck_get_service_balance + peck_withdraw_earnings
 * via MCP stdio. Withdraws memory-store-v2's accumulated earnings to worker2.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: any; error?: any }

const wallets = JSON.parse(fs.readFileSync('.wallets.json', 'utf8'))
const recipient = wallets.worker2.address
console.log(`recipient (worker2): ${recipient}`)

const proc = spawn('npx', ['tsx', 'src/mcp/peck-mcp.ts'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''; let nextId = 1
const pending = new Map<number, (m: JsonRpcResponse) => void>()
proc.stdout.on('data', c => {
  buf += c.toString()
  let nl: number
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    try { const m = JSON.parse(line) as JsonRpcResponse; if (m.id != null) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m) } } } catch {}
  }
})
proc.stderr.on('data', c => process.stderr.write('[mcp] ' + c.toString()))

function req(method: string, params: any = {}): Promise<JsonRpcResponse> {
  const id = nextId++
  return new Promise(r => { pending.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
}
function unwrap(r: JsonRpcResponse): any {
  if (r.error) throw new Error(JSON.stringify(r.error))
  const c = r.result?.content
  if (Array.isArray(c) && c[0]?.type === 'text') {
    try { return JSON.parse(c[0].text) } catch { return c[0].text }
  }
  return r.result
}

async function main() {
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  await req('notifications/initialized')

  console.log('\n=== peck_get_service_balance memory-store-v2 ===')
  const b1 = unwrap(await req('tools/call', {
    name: 'peck_get_service_balance',
    arguments: { service_id: 'memory-store-v2' },
  }))
  console.log(`  available: ${b1.available_balance} sat`)
  console.log(`  earned: ${b1.earned_total}, held (locked): ${b1.held_total}, marketplace fee: ${b1.marketplace_total}`)
  console.log(`  calls: ${b1.calls_count}, withdrawn: ${b1.withdrawn_total}`)

  console.log(`\n=== peck_withdraw_earnings memory-store-v2 → ${recipient} ===`)
  const w = unwrap(await req('tools/call', {
    name: 'peck_withdraw_earnings',
    arguments: { service_id: 'memory-store-v2', recipient_address: recipient },
  }))
  if (w.error) {
    console.log(`  ERROR: ${w.error}`)
    if (w.detail) console.log(`  ${w.detail}`)
  } else {
    console.log(`  amount_withdrawn: ${w.amount_withdrawn} sat`)
    console.log(`  withdrawal_txid: ${w.withdrawal_txid?.slice(0, 16)}…`)
    console.log(`  explorer: ${w.explorer}`)
    console.log(`  new_balance: available=${w.new_balance.available_balance}, held still locked=${w.new_balance.held_total}`)
  }

  console.log('\n=== peck_get_service_balance after withdrawal ===')
  const b2 = unwrap(await req('tools/call', {
    name: 'peck_get_service_balance',
    arguments: { service_id: 'memory-store-v2' },
  }))
  console.log(`  available: ${b2.available_balance} sat (was ${b1.available_balance})`)
  console.log(`  withdrawn_total: ${b2.withdrawn_total} sat`)
  console.log(`  held still locked: ${b2.held_total} sat`)

  console.log('\n[test-withdraw] DONE')
  proc.kill()
}

main().catch(e => { console.error('FAILED', e); proc.kill(); process.exit(1) })
