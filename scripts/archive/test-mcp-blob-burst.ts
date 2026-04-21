/**
 * test-mcp-blob-burst.ts — exercise the blob path of memory-agent v2 via MCP.
 *
 * Each write sends a large (>1KB) value, which routes through storage-shim
 * (uploads to fake-gcs, writes its own fee receipt OP_RETURN tx) and
 * bank-shim (writes its own fee receipt) before the actual memory-write
 * OP_RETURN tx that anchors the blob handle. So each call should produce
 * 3 on-chain txs.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

const N = parseInt(process.env.N_WRITES || '5', 10)
const NS = process.env.NAMESPACE || 'mcp-blob-burst'
const TAG = process.env.TAG || 'blob-burst'
const SIZE_BYTES = parseInt(process.env.SIZE_BYTES || '2500', 10)

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: any; error?: any }

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (msg: JsonRpcResponse) => void>()
  constructor() {
    this.proc = spawn('npx', ['tsx', 'src/mcp/peck-mcp.ts'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    this.proc.stdout.on('data', (c) => this.onData(c.toString()))
    this.proc.stderr.on('data', (c) => process.stderr.write(`[mcp-stderr] ${c}`))
  }
  private onData(s: string) {
    this.buf += s
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (msg.id != null) {
          const cb = this.pending.get(msg.id)
          if (cb) { this.pending.delete(msg.id); cb(msg) }
        }
      } catch {}
    }
  }
  request(method: string, params: any = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}#${id}`)) } }, 90_000)
    })
  }
  async close() { this.proc.stdin.end(); this.proc.kill() }
}

function unwrap(resp: JsonRpcResponse): any {
  if (resp.error) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`)
  const c = resp.result?.content
  if (Array.isArray(c) && c[0]?.type === 'text') {
    try { return JSON.parse(c[0].text) } catch { return c[0].text }
  }
  return resp.result
}

async function main() {
  console.log(`[blob-burst] N=${N} ns=${NS} size=${SIZE_BYTES}B`)
  const cli = new McpStdioClient()
  await cli.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'blob-burst', version: '1.0' } })
  cli.request('notifications/initialized', {})
  await cli.request('tools/list', {})

  // Generate a deterministic large string
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(SIZE_BYTES / 27))
  const valueBase = filler.slice(0, SIZE_BYTES)

  console.log(`\n[blob-burst] ${N} writes via MCP, each ${valueBase.length}B…`)
  const results: Array<{ k: string; ok: boolean; tx_count?: number; path?: string; blob?: string; err?: string }> = []
  for (let i = 1; i <= N; i++) {
    const key = `blob-${String(i).padStart(3, '0')}`
    const value = `[${i}] ${valueBase}`
    try {
      const resp = await cli.request('tools/call', {
        name: 'peck_memory_write',
        arguments: { namespace: NS, key, value, tags: [TAG, `seq-${i}`] },
      })
      const r = unwrap(resp)
      if (r?.error) {
        console.log(`  ${i.toString().padStart(2)}. ❌ ${key}  ${r.error}`)
        results.push({ k: key, ok: false, err: r.error })
      } else {
        const txc = r.tx_count ?? 0
        console.log(`  ${i.toString().padStart(2)}. ✅ ${key}  txs=${txc}  path=${r.path}  blob=${r.blob_handle?.slice(5, 21)}…`)
        results.push({ k: key, ok: true, tx_count: txc, path: r.path, blob: r.blob_handle })
      }
    } catch (e: any) {
      console.log(`  ${i.toString().padStart(2)}. 💥 ${key}  ${e?.message}`)
      results.push({ k: key, ok: false, err: e?.message })
    }
  }

  const succ = results.filter(r => r.ok).length
  const total_txs = results.reduce((s, r) => s + (r.tx_count ?? 0), 0)
  const blob_path = results.filter(r => r.path === 'blob').length

  // Verify a read round-trips a blob
  if (results[0]?.ok) {
    const list = unwrap(await cli.request('tools/call', { name: 'peck_memory_list', arguments: { namespace: NS } }))
    const handle = list?.items?.[0]?.handle
    if (handle) {
      const read = unwrap(await cli.request('tools/call', { name: 'peck_memory_read', arguments: { handle } }))
      console.log(`\n[blob-burst] read round-trip: ${read.value?.length}B  path=${read.path}  ok=${read.value?.startsWith('[')}`)
    }
  }

  console.log(`\n[blob-burst] DONE: ${succ}/${N} writes, ${blob_path}/${succ} via blob path, ${total_txs} on-chain txs`)
  await cli.close()
}

main().catch(e => { console.error('FAILED', e); process.exit(1) })
