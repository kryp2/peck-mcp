/**
 * test-mcp-workflows.ts — exercise the workflow tools end to end via MCP
 * stdio: list workflows, run one, register a custom one.
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
      try { const msg = JSON.parse(line) as JsonRpcResponse; if (msg.id != null) { const cb = this.pending.get(msg.id); if (cb) { this.pending.delete(msg.id); cb(msg) } } } catch {}
    }
  }
  request(method: string, params: any = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}#${id}`)) } }, 120_000)
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
  await cli.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-workflows', version: '1.0' } })
  cli.request('notifications/initialized', {})

  console.log('=== peck_list_workflows ===')
  const list = unwrap(await cli.request('tools/call', { name: 'peck_list_workflows', arguments: {} }))
  console.log(`  count: ${list.count}`)
  for (const wf of list.workflows ?? []) {
    console.log(`  - ${wf.id}  steps=${wf.step_count}  ~${wf.estimated_cost_sats}sat  "${wf.name}"`)
  }

  console.log('\n=== peck_run_workflow research-and-remember ===')
  const run = unwrap(await cli.request('tools/call', {
    name: 'peck_run_workflow',
    arguments: {
      workflow_id: 'research-and-remember',
      input: {
        url: 'https://en.wikipedia.org/wiki/Markov_chain',
        namespace: 'mcp-workflow-test',
        key: 'markov-research',
      },
    },
  }))
  if (run.error) {
    console.log(`  ❌ ${run.error}`)
    if (run.detail) console.log(`     ${run.detail.slice(0, 300)}`)
  } else {
    console.log(`  ok=${run.ok}  steps_run=${run.steps_run}  total_ms=${run.total_ms}`)
    for (const step of run.trace ?? []) {
      console.log(`    [${step.id}] ${step.capability}  ${step.duration_ms}ms  keys=${step.result_keys?.slice(0, 5).join(',')}`)
    }
    if (run.result) {
      console.log(`  final result keys: ${Object.keys(run.result).join(', ')}`)
      if (run.result.txid) console.log(`  notarize txid: ${run.result.txid?.slice(0, 16)}…`)
    }
  }

  console.log('\n=== peck_register_workflow my-custom-workflow ===')
  const reg = unwrap(await cli.request('tools/call', {
    name: 'peck_register_workflow',
    arguments: {
      id: 'embed-and-anchor',
      name: 'Embed text and anchor it on chain',
      description: 'Custom workflow registered via MCP for testing — embeds text, then notarizes the embedding hash.',
      author: 'test-script',
      estimated_cost_sats: 30,
      steps: [
        {
          id: 'embedding',
          service_url: 'http://localhost:4041',
          capability: 'embed',
          input: { text: '$input.text' },
        },
        {
          id: 'anchor',
          service_url: 'http://localhost:4039',
          capability: 'notarize',
          input: { hash: '$embedding.text_sha256', note: 'embedded:$input.text' },
        },
      ],
    },
  }))
  console.log(`  registered: handle=${reg.handle?.slice(0, 16)}…`)

  console.log('\n=== peck_run_workflow embed-and-anchor (custom one we just registered) ===')
  const run2 = unwrap(await cli.request('tools/call', {
    name: 'peck_run_workflow',
    arguments: { workflow_id: 'embed-and-anchor', input: { text: 'workflows are data, not code' } },
  }))
  if (run2.error) {
    console.log(`  ❌ ${run2.error}`)
  } else {
    console.log(`  ok=${run2.ok}  steps_run=${run2.steps_run}  total_ms=${run2.total_ms}`)
    for (const step of run2.trace ?? []) console.log(`    [${step.id}] ${step.capability}  ${step.duration_ms}ms`)
    if (run2.result?.txid) console.log(`  anchor txid: ${run2.result.txid?.slice(0, 16)}…`)
  }

  console.log('\n[test-workflows] DONE')
  await cli.close()
}

main().catch(e => { console.error('FAILED', e); process.exit(1) })
