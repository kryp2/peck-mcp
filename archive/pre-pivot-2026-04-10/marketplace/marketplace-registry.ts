/**
 * Pure marketplace registry — discovery + live event feed.
 *
 * Does NOT route requests, does NOT take payments. Buyers discover services
 * here and then talk directly to each service via BRC-100 P2P payment.
 *
 * Endpoints:
 *   GET /marketplace        — list all known service-agents (catalog snapshot)
 *   GET /events             — SSE stream of marketplace events (joins, payments)
 *   POST /announce          — service-agents POST here on boot to register
 *   POST /event             — service-agents POST here when something happens (paid call, etc)
 *   GET /                   — minimal HTML dashboard
 */
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'

export interface RegistryEntry {
  id: string                  // logical id (e.g. "weather")
  name: string                // service name (e.g. "weather-agent")
  identityKey: string         // BRC-100 pubkey of the service
  endpoint: string            // base URL (e.g. http://localhost:3002)
  capabilities: string[]
  pricePerCall: number
  description: string
  registeredAt: number
}

export interface RegistryEvent {
  type: 'announce' | 'paid' | 'error'
  service: string
  capability?: string
  payer?: string
  amount?: number
  txid?: string
  ms?: number
  detail?: string
  ts: number
}

export class MarketplaceRegistry {
  private entries: Map<string, RegistryEntry> = new Map()
  private bus = new EventEmitter()

  constructor() {
    this.bus.setMaxListeners(50)
  }

  register(entry: Omit<RegistryEntry, 'registeredAt'>): void {
    const full: RegistryEntry = { ...entry, registeredAt: Date.now() }
    this.entries.set(entry.id, full)
    this.emit({ type: 'announce', service: entry.id, ts: Date.now() })
  }

  list(): RegistryEntry[] { return Array.from(this.entries.values()) }
  get(id: string): RegistryEntry | undefined { return this.entries.get(id) }

  emit(event: RegistryEvent): void { this.bus.emit('event', event) }
  onEvent(listener: (e: RegistryEvent) => void): () => void {
    this.bus.on('event', listener)
    return () => this.bus.off('event', listener)
  }

  async start(port: number): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>(r => server.listen(port, () => r()))
    console.log(`[registry] http://localhost:${port}`)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DASHBOARD_HTML)
      return
    }

    if (req.method === 'GET' && req.url === '/marketplace') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.list()))
      return
    }

    if (req.method === 'POST' && req.url === '/announce') {
      this.readBody(req).then(body => {
        try {
          const entry = JSON.parse(body) as Omit<RegistryEntry, 'registeredAt'>
          this.register(entry)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/event') {
      this.readBody(req).then(body => {
        try {
          const event = JSON.parse(body) as RegistryEvent
          event.ts = event.ts || Date.now()
          this.emit(event)
          res.writeHead(200); res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(': connected\n\n')
      const off = this.onEvent((e) => {
        res.write(`data: ${JSON.stringify(e)}\n\n`)
      })
      const ka = setInterval(() => res.write(': ka\n\n'), 15000)
      req.on('close', () => { off(); clearInterval(ka) })
      return
    }

    res.writeHead(404); res.end()
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of req) body += chunk
    return body
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Peck Pay — BRC-100 Marketplace</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0b0f14; color: #d8e1ea; margin: 0; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; color: #6cf; }
  h2 { margin: 16px 0 8px; font-size: 14px; color: #8aa; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .panel { background: #131a22; border-radius: 8px; padding: 16px; }
  .svc { padding: 8px 0; border-bottom: 1px solid #1f2a36; font-size: 12px; }
  .svc .id { color: #fff; font-weight: bold; }
  .svc .price { color: #6cf; }
  .svc .ident { color: #678; font-size: 10px; word-break: break-all; }
  .feed { height: 70vh; overflow-y: auto; }
  .row { padding: 5px 0; border-bottom: 1px solid #1a232d; font-size: 11px; }
  .row.paid { color: #9be4a8; }
  .row.announce { color: #6cf; }
  .row.error { color: #ff6b6b; }
  a { color: inherit; }
</style></head>
<body>
<h1>Peck Pay — BRC-100 Marketplace</h1>
<div class="grid">
  <div class="panel">
    <h2>SERVICES (BRC-100 P2P)</h2>
    <div id="svc"></div>
  </div>
  <div class="panel">
    <h2>LIVE FEED</h2>
    <div class="feed" id="feed"></div>
  </div>
</div>
<script>
  async function refresh() {
    const r = await fetch('/marketplace');
    const list = await r.json();
    document.getElementById('svc').innerHTML = list.map(s =>
      \`<div class="svc">
        <div><span class="id">\${s.id}</span> — <span class="price">\${s.pricePerCall} sat</span></div>
        <div>\${s.capabilities.join(', ')}</div>
        <div class="ident">\${s.identityKey}</div>
        <div>\${s.endpoint}</div>
       </div>\`
    ).join('');
  }
  setInterval(refresh, 5000); refresh();

  const feed = document.getElementById('feed');
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    const div = document.createElement('div');
    div.className = 'row ' + ev.type;
    let line = '';
    if (ev.type === 'announce') line = \`+ \${ev.service} announced\`;
    else if (ev.type === 'paid') {
      const url = 'https://test.whatsonchain.com/tx/' + ev.txid;
      line = \`\${ev.service}/\${ev.capability} ← \${ev.amount} sat from \${ev.payer?.slice(0,16)}…  <a href="\${url}" target="_blank">\${ev.txid?.slice(0,16)}…</a>\`;
    } else if (ev.type === 'error') line = \`! \${ev.service}: \${ev.detail}\`;
    div.innerHTML = \`[\${new Date(ev.ts).toLocaleTimeString()}] \${line}\`;
    feed.insertBefore(div, feed.firstChild);
    while (feed.children.length > 200) feed.removeChild(feed.lastChild);
  };
</script>
</body></html>`
