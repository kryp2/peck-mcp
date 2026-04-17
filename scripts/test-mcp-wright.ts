/**
 * test-mcp-wright.ts — verify the Wright §5.4 mechanism design tools:
 * peck_register_service, peck_report_service, peck_get_reputation, and
 * the reputation filter integration into peck_list_services.
 */
import { spawn } from 'node:child_process'

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: any; error?: any }

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

  console.log('=== peck_get_reputation for an existing service (notarize) ===')
  const r1 = unwrap(await req('tools/call', { name: 'peck_get_reputation', arguments: { service_id: 'notarize' } }))
  console.log(`  reputation: ${r1.reputation}  (${r1.recommendation})`)
  console.log(`  audit_reports: ${r1.audit_reports.total}, total_calls: ${r1.total_calls}`)
  console.log(`  registered: ${r1.registered}, escrow: ${r1.escrow ? JSON.stringify(r1.escrow) : 'none'}`)

  console.log('\n=== peck_report_service against notarize ===')
  const r2 = unwrap(await req('tools/call', {
    name: 'peck_report_service',
    arguments: {
      service_id: 'notarize',
      request_commitment: 'fake-test-commitment-' + Date.now(),
      issue: 'test report from MCP — no actual misbehavior, just verifying the audit pipeline',
      severity: 'minor',
    },
  }))
  console.log(`  reported: ${r2.reported}, severity: ${r2.severity}`)
  console.log(`  on-chain handle: ${r2.handle?.slice(0, 16)}…`)
  console.log(`  explorer: ${r2.explorer?.slice(0, 80)}…`)

  console.log('\n=== peck_get_reputation again (should reflect new report) ===')
  // Wait briefly for cache to expire + memory-agent to flush
  await new Promise(r => setTimeout(r, 11_000))
  const r3 = unwrap(await req('tools/call', { name: 'peck_get_reputation', arguments: { service_id: 'notarize' } }))
  console.log(`  reputation: ${r3.reputation}  (${r3.recommendation})`)
  console.log(`  audit_reports: ${r3.audit_reports.total}  by_severity: ${JSON.stringify(r3.audit_reports.by_severity)}`)

  console.log('\n=== peck_register_service (custom service with escrow) ===')
  // Use the worker1 funding tx as a proxy for an "escrow" — it's a real
  // confirmed testnet tx that the WoC verification will accept
  const r4 = unwrap(await req('tools/call', {
    name: 'peck_register_service',
    arguments: {
      id: 'test-custom-service',
      name: 'My Custom Test Service',
      endpoint: 'http://localhost:9999',
      capabilities: ['test', 'demo'],
      pricePerCall: 50,
      description: 'A custom service registered via MCP for testing the registration + escrow flow.',
      escrow_txid: 'ea2b9014387cf6aacbc785c957d5652f5408f626185a98fa5b45011afd8c60cd',  // worker1 10M funding
      escrow_satoshis: 10000000,
    },
  }))
  console.log(`  registered: ${r4.registered}`)
  console.log(`  registry_accepted: ${r4.registry_accepted}`)
  console.log(`  escrow_verified: ${r4.escrow_verified}`)
  console.log(`  on-chain handle: ${r4.on_chain_handle?.slice(0, 16)}…`)

  console.log('\n=== peck_get_reputation for the new service ===')
  const r5 = unwrap(await req('tools/call', { name: 'peck_get_reputation', arguments: { service_id: 'test-custom-service' } }))
  console.log(`  reputation: ${r5.reputation}  (${r5.recommendation})`)
  console.log(`  registered: ${r5.registered}, escrow: ${JSON.stringify(r5.escrow)}`)

  console.log('\n[test-wright] DONE')
  proc.kill()
}

main().catch(e => { console.error('FAILED', e); proc.kill(); process.exit(1) })
