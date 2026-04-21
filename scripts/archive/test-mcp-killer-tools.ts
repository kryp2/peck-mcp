/**
 * test-mcp-killer-tools.ts — exercise the 3 new MCP tools (notarize,
 * summarize-url, embed-text) end to end via JSON-RPC stdio.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: any; error?: any }

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (msg: JsonRpcResponse) => void>()
  constructor() {
    this.proc = spawn('npx', ['tsx', 'src/mcp/peck-mcp.ts'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    this.proc.stdout.on('data', c => this.onData(c.toString()))
    this.proc.stderr.on('data', c => process.stderr.write(`[mcp] ${c}`))
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
        if (msg.id != null) { const cb = this.pending.get(msg.id); if (cb) { this.pending.delete(msg.id); cb(msg) } }
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
  const cli = new McpStdioClient()
  await cli.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-killer', version: '1.0' } })
  cli.request('notifications/initialized', {})

  console.log('=== tools/list (looking for the 3 new ones) ===')
  const list = await cli.request('tools/list', {})
  const tools: Array<{ name: string }> = list.result?.tools ?? []
  const killers = tools.filter(t => ['peck_notarize', 'peck_summarize_url', 'peck_embed_text'].includes(t.name))
  console.log(`  total tools: ${tools.length}, killer tools: ${killers.map(t => t.name).join(', ')}`)
  if (killers.length !== 3) throw new Error(`expected 3 killer tools, got ${killers.length}`)

  console.log('\n=== peck_notarize ===')
  const n = unwrap(await cli.request('tools/call', {
    name: 'peck_notarize',
    arguments: { data: { idea: 'workflows as data is the moat', when: '2026-04-09' }, note: 'mcp-test' },
  }))
  console.log(`  hash: ${n.hash?.slice(0, 16)}…`)
  console.log(`  txid: ${n.txid?.slice(0, 16)}…`)
  console.log(`  fee_receipt: ${n.fee_receipt_txid?.slice(0, 16)}…`)
  console.log(`  iso_timestamp: ${n.iso_timestamp}`)

  console.log('\n=== peck_embed_text ===')
  const e = unwrap(await cli.request('tools/call', {
    name: 'peck_embed_text',
    arguments: { text: 'The quick brown fox jumps over the lazy dog' },
  }))
  console.log(`  source: ${e.embedding_source}`)
  console.log(`  dim: ${e.dim}`)
  console.log(`  first5: ${e.embedding?.slice(0, 5).map((x: number) => x.toFixed(3)).join(', ')}`)

  console.log('\n=== peck_summarize_url ===')
  const s = unwrap(await cli.request('tools/call', {
    name: 'peck_summarize_url',
    arguments: { url: 'https://en.wikipedia.org/wiki/Markov_chain', max_bytes: 15000 },
  }))
  if (s.error) console.log('  error:', s.error)
  else {
    console.log(`  topic: ${s.topic}`)
    console.log(`  summary: ${s.summary?.slice(0, 200)}`)
    console.log(`  key_points: ${JSON.stringify(s.key_points)}`)
    console.log(`  total_ms: ${s.total_ms}`)
  }

  console.log('\n[test-killer-tools] DONE')
  await cli.close()
}

main().catch(e => { console.error('FAILED', e); process.exit(1) })
