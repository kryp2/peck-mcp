/**
 * Dashboard server — minimal HTTP + SSE feed of Gateway activity.
 *
 * GET /            → static HTML dashboard (live tx feed + stats)
 * GET /events      → text/event-stream of GatewayEvent objects
 * GET /stats       → current Gateway snapshot (JSON)
 */
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Gateway, GatewayEvent } from './gateway.js'

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Peck Pay — Live</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0b0f14; color: #d8e1ea; margin: 0; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; color: #6cf; }
  .stats { display: flex; gap: 24px; margin: 16px 0 24px; }
  .stat { background: #131a22; padding: 12px 16px; border-radius: 8px; min-width: 140px; }
  .stat .k { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 1px; }
  .stat .v { font-size: 24px; color: #fff; margin-top: 4px; }
  .feed { background: #0e141b; border: 1px solid #1f2a36; border-radius: 8px; padding: 12px; height: 60vh; overflow-y: auto; }
  .row { padding: 6px 8px; border-bottom: 1px solid #1a232d; font-size: 12px; }
  .row.job { color: #9be4a8; }
  .row.payment { color: #6cf; }
  .row.error { color: #ff6b6b; }
  a { color: inherit; text-decoration: underline; }
</style></head>
<body>
<h1>Peck Pay — Live Marketplace</h1>
<div class="stats">
  <div class="stat"><div class="k">Jobs Completed</div><div class="v" id="jobs">0</div></div>
  <div class="stat"><div class="k">TX Broadcast</div><div class="v" id="txs">0</div></div>
  <div class="stat"><div class="k">Total Paid (sat)</div><div class="v" id="paid">0</div></div>
  <div class="stat"><div class="k">Last TXID</div><div class="v" id="last" style="font-size:11px;word-break:break-all">—</div></div>
</div>
<div class="feed" id="feed"></div>
<script>
  const feed = document.getElementById('feed');
  const fmt = (s) => s.length > 60 ? s.slice(0,60)+'…' : s;
  function addRow(html, cls) {
    const div = document.createElement('div');
    div.className = 'row ' + cls;
    div.innerHTML = html;
    feed.prepend(div);
    while (feed.children.length > 200) feed.removeChild(feed.lastChild);
  }
  async function refresh() {
    const r = await fetch('/stats');
    const s = await r.json();
    document.getElementById('jobs').textContent = s.jobsCompleted;
    document.getElementById('txs').textContent = s.txBroadcast;
    document.getElementById('paid').textContent = s.totalPaid;
    document.getElementById('last').textContent = s.lastTxid || '—';
  }
  setInterval(refresh, 1000); refresh();
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'job') {
      addRow(\`#\${ev.jobNumber} job → \${ev.workerId} (\${ev.latencyMs}ms) "\${fmt(ev.promptHead)}"\`, 'job');
    } else if (ev.type === 'payment') {
      const url = 'https://test.whatsonchain.com/tx/' + ev.txid;
      addRow(\`#\${ev.txCount} pay \${ev.amount} sat → \${ev.workerId} <a href="\${url}" target="_blank">\${ev.txid.slice(0,16)}…</a>\`, 'payment');
    } else if (ev.type === 'error') {
      addRow(\`error \${ev.workerId}: \${ev.message}\`, 'error');
    }
  };
</script>
</body></html>`

export function startDashboard(gw: Gateway, port: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(gw.stats))
      return
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(': connected\n\n')
      const listener = (ev: GatewayEvent) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }
      gw.events.on('event', listener)
      // keepalive
      const ka = setInterval(() => res.write(': ka\n\n'), 15000)
      req.on('close', () => {
        gw.events.off('event', listener)
        clearInterval(ka)
      })
      return
    }
    res.writeHead(404); res.end()
  })
  server.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}`)
  })
}
