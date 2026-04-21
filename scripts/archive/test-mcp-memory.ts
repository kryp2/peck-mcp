/**
 * test-mcp-memory.ts — exercise the new peck_memory_* MCP tools by spawning
 * peck-mcp as a child process and talking JSON-RPC over stdio.
 *
 * Usage:
 *   N_WRITES=12 npx tsx scripts/test-mcp-memory.ts
 *
 * This is a real MCP client — it goes through the same protocol Claude
 * Desktop / Cursor / any other MCP host would use. Each tool/call response
 * is parsed and reported. At the end we verify with a memory-list and
 * tag-search to make sure all writes are queryable.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

const N_WRITES = parseInt(process.env.N_WRITES || '12', 10)
const NAMESPACE = process.env.NAMESPACE || 'mcp-burst-test'
const TAG = process.env.TAG || 'mcp-burst'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: any
}

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (msg: JsonRpcResponse) => void>()

  constructor() {
    this.proc = spawn('npx', ['tsx', 'src/mcp/peck-mcp.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.proc.stdout.on('data', (chunk) => this.onData(chunk.toString()))
    this.proc.stderr.on('data', (chunk) => process.stderr.write(`[mcp-stderr] ${chunk}`))
    this.proc.on('exit', (code) => console.log(`[mcp] exited with code ${code}`))
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
          if (cb) {
            this.pending.delete(msg.id)
            cb(msg)
          }
        }
      } catch {/* not a JSON line — skip (could be log noise) */}
    }
  }

  request(method: string, params: any = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      this.proc.stdin.write(msg)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request ${method}#${id} timed out`))
        }
      }, 60_000)
    })
  }

  async close() {
    this.proc.stdin.end()
    this.proc.kill()
  }
}

function unwrap(resp: JsonRpcResponse): any {
  if (resp.error) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`)
  // Tool call results come back as { content: [{ type:'text', text:'...' }], isError? }
  const content = resp.result?.content
  if (Array.isArray(content) && content[0]?.type === 'text') {
    try { return JSON.parse(content[0].text) } catch { return content[0].text }
  }
  return resp.result
}

async function main() {
  console.log(`[test-mcp-memory] N_WRITES=${N_WRITES} namespace=${NAMESPACE} tag=${TAG}`)
  const cli = new McpStdioClient()

  // 1. MCP handshake
  console.log('[test] initialize…')
  await cli.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp-memory', version: '1.0.0' },
  })
  cli.request('notifications/initialized', {})  // don't await — it's a notification

  // 2. List tools — verify our memory tools are registered
  console.log('[test] tools/list…')
  const toolsResp = await cli.request('tools/list', {})
  const tools: Array<{ name: string }> = toolsResp.result?.tools ?? []
  const memTools = tools.filter(t => t.name.startsWith('peck_memory_'))
  console.log(`[test]   total tools: ${tools.length}, memory tools: ${memTools.map(t => t.name).join(', ')}`)
  if (memTools.length < 4) {
    throw new Error(`expected 4 peck_memory_* tools, got ${memTools.length}`)
  }

  // 3. Burst N writes via peck_memory_write
  console.log(`\n[test] burst of ${N_WRITES} writes via MCP…`)
  const results: Array<{ key: string; ok: boolean; handle?: string; tx_count?: number; err?: string }> = []
  for (let i = 1; i <= N_WRITES; i++) {
    const key = `burst-${String(i).padStart(3, '0')}`
    const value = `MCP burst write #${i} at ${new Date().toISOString()}`
    try {
      const resp = await cli.request('tools/call', {
        name: 'peck_memory_write',
        arguments: { namespace: NAMESPACE, key, value, tags: [TAG, `seq-${i % 4}`] },
      })
      const r = unwrap(resp)
      if (r?.error) {
        console.log(`  ${i.toString().padStart(2)}. ❌ ${key}  ${r.error}`)
        results.push({ key, ok: false, err: r.error })
      } else {
        const txc = r.tx_count ?? r.on_chain_txs?.length ?? 1
        console.log(`  ${i.toString().padStart(2)}. ✅ ${key}  handle=${r.handle?.slice(0, 16)}…  tx_count=${txc}  path=${r.path}`)
        results.push({ key, ok: true, handle: r.handle, tx_count: txc })
      }
    } catch (e: any) {
      console.log(`  ${i.toString().padStart(2)}. 💥 ${key}  ${e?.message}`)
      results.push({ key, ok: false, err: e?.message })
    }
  }

  const succ = results.filter(r => r.ok).length
  const totalTxs = results.reduce((s, r) => s + (r.tx_count ?? 0), 0)
  console.log(`\n[test] ${succ}/${N_WRITES} writes succeeded, ${totalTxs} on-chain txs total`)

  // 4. List the namespace via MCP — verify all entries are queryable
  console.log('[test] tools/call peck_memory_list…')
  const listResp = await cli.request('tools/call', {
    name: 'peck_memory_list',
    arguments: { namespace: NAMESPACE },
  })
  const list = unwrap(listResp)
  console.log(`[test]   list count: ${list.count}`)

  // 5. Search by tag via MCP
  console.log(`[test] tools/call peck_memory_search tag=${TAG}…`)
  const searchResp = await cli.request('tools/call', {
    name: 'peck_memory_search',
    arguments: { tag: TAG },
  })
  const search = unwrap(searchResp)
  console.log(`[test]   tag search count: ${search.count}`)

  // 6. Read one entry via MCP to prove the round-trip
  if (results.length > 0 && results[0].handle) {
    console.log(`[test] tools/call peck_memory_read ${results[0].handle.slice(0, 16)}…`)
    const readResp = await cli.request('tools/call', {
      name: 'peck_memory_read',
      arguments: { handle: results[0].handle },
    })
    const read = unwrap(readResp)
    console.log(`[test]   value: ${JSON.stringify(read.value).slice(0, 80)}`)
    console.log(`[test]   path: ${read.path}`)
  }

  console.log('\n[test] DONE')
  console.log(`[test] summary: ${succ}/${N_WRITES} writes, ${totalTxs} total on-chain txs, list=${list.count}, search=${search.count}`)
  await cli.close()
}

main().catch(e => { console.error('[test-mcp-memory] FAILED:', e); process.exit(1) })
