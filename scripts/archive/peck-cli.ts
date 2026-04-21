#!/usr/bin/env npx tsx
/**
 * peck-cli.ts — one-shot CLI for mcp.peck.to tool calls. Does its own
 * init handshake each invocation, so it's safe for sub-agents that can't
 * reuse the harness MCP session.
 *
 * Usage:
 *   npx tsx scripts/peck-cli.ts <tool_name> '<args_json>'
 *
 * Examples:
 *   npx tsx scripts/peck-cli.ts peck_stats '{}'
 *   npx tsx scripts/peck-cli.ts peck_balance '{"address":"13rVf..."}'
 *   npx tsx scripts/peck-cli.ts peck_post_tx '{"content":"hi","signing_key":"<hex>","agent_app":"peck.agents","tags":["intro"]}'
 *
 * Prints the tool result JSON (pretty) to stdout. Non-zero exit on error.
 */
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'

const TOOL = process.argv[2]
const ARGS_STR = process.argv[3] || '{}'
if (!TOOL) {
  console.error('usage: peck-cli.ts <tool_name> [args_json]')
  process.exit(2)
}
let args: any
try { args = JSON.parse(ARGS_STR) } catch (e: any) {
  console.error(`[peck-cli] bad args json: ${e.message}`)
  process.exit(2)
}

async function initSession(): Promise<string> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'peck-cli', version: '1' },
      },
    }),
  })
  const session = r.headers.get('mcp-session-id')
  if (!session) throw new Error(`no mcp-session-id (http ${r.status})`)

  // Ack initialize
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return session
}

async function callTool(session: string, name: string, a: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'tools/call',
      params: { name, arguments: a },
    }),
  })
  const raw = await r.text()
  const dataLine = raw.split('\n').find(l => l.startsWith('data: '))
  if (!dataLine) throw new Error(`no data line (http ${r.status}): ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(dataLine.slice(6))
  if (parsed.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  const text = parsed.result?.content?.[0]?.text
  if (!text) return parsed.result
  try { return JSON.parse(text) } catch { return text }
}

async function main() {
  // One retry on transient transport errors
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const session = await initSession()
      const result = await callTool(session, TOOL, args)
      console.log(JSON.stringify(result, null, 2))
      return
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? e)
      // retry on transient network / 5xx / rate limit
      if (/(fetch failed|ECONNRESET|ETIMEDOUT|5\d\d|429)/i.test(msg) && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      break
    }
  }
  console.error(`[peck-cli] FAIL: ${lastErr?.message ?? lastErr}`)
  process.exit(1)
}

main()
