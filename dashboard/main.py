"""
Peck Pay — Marketplace Dashboard
FastHTML + peck-ui + WebSocket live updates
"""
import sys
import json
import asyncio
import logging
from pathlib import Path
from typing import Optional

# Add peck-ui to path so we can import peck_ui
# dashboard/main.py → dashboard/ → ap_AP4A/ → .worktrees/ → hackathon-agentic-pay/ → peck-to/
PECK_UI_PATH = Path(__file__).parent.parent.parent.parent.parent / "peck-ui"
if PECK_UI_PATH.exists():
    sys.path.insert(0, str(PECK_UI_PATH))

from starlette.applications import Starlette
from starlette.responses import HTMLResponse
from starlette.routing import Route, Mount, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
from starlette.requests import Request

try:
    from peck_ui.fasthtml import (
        peck_head, peck_icon, peck_app,
        button, card, badge, stat, row, stack, grid, container, box,
        heading, text, navbar,
    )
    PECK_UI_OK = True
except ImportError:
    PECK_UI_OK = False

log = logging.getLogger("peck-pay-dashboard")

# ── State ─────────────────────────────────────────────────────────────────────

# In-memory state — populated by WS events from TS agent backend
state = {
    "agents": {},          # id → {id, name, capabilities, price, status, lastSeen}
    "txs": [],             # recent transactions (capped at 500)
    "stats": {
        "agents_online": 0,
        "txs_today": 0,
        "total_bsv_satoshis": 0,
    },
    "demo_running": False,
}

# Connected browser WebSocket clients
browser_clients: set[WebSocket] = set()

# ── Helpers ───────────────────────────────────────────────────────────────────

def satoshis_to_bsv(sats: int) -> str:
    return f"{sats / 1e8:.8f}"

def satoshis_to_usd(sats: int, bsv_usd: float = 40.0) -> str:
    return f"${sats / 1e8 * bsv_usd:.4f}"

def peck_ui_base() -> str:
    return "/static/peck-ui"

async def broadcast(msg: dict):
    """Broadcast JSON event to all connected browser clients."""
    dead = set()
    data = json.dumps(msg)
    for ws in browser_clients:
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    browser_clients.difference_update(dead)

# ── HTML Helpers ──────────────────────────────────────────────────────────────

BASE_PATH = "/static/peck-ui"

def html_page(title: str, body: str, extra_head: str = "") -> str:
    """Render a full HTML page with peck-ui tokens."""
    return f"""<!DOCTYPE html>
<html lang="no" data-theme="dark" data-peck-app="web">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — Peck Pay</title>
  <link rel="stylesheet" href="{BASE_PATH}/tokens.css">
  <link rel="stylesheet" href="{BASE_PATH}/peck-icons.css">
  <script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
  <script src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
  {extra_head}
  <style>
    /* ── Layout ── */
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: var(--peck-font-sans, system-ui, sans-serif);
      background: var(--peck-bg, #0f1117);
      color: var(--peck-fg, #e8eaf0);
      min-height: 100vh;
    }}

    /* ── Nav ── */
    .peck-topnav {{
      display: flex; align-items: center; gap: 1.5rem;
      padding: .75rem 1.5rem;
      background: rgba(255,255,255,.04);
      border-bottom: 1px solid rgba(255,255,255,.08);
      position: sticky; top: 0; z-index: 100;
      backdrop-filter: blur(12px);
    }}
    .peck-topnav__logo {{
      font-weight: 700; font-size: 1.1rem;
      color: var(--peck-accent, #6c63ff);
      text-decoration: none;
    }}
    .peck-topnav__links {{ display: flex; gap: 1rem; list-style: none; margin: 0; padding: 0; }}
    .peck-topnav__links a {{
      color: var(--peck-fg-muted, #9097a8);
      text-decoration: none; font-size: .9rem;
      transition: color .15s;
    }}
    .peck-topnav__links a:hover, .peck-topnav__links a.active {{
      color: var(--peck-fg, #e8eaf0);
    }}
    .peck-topnav__spacer {{ flex: 1; }}

    /* ── Stat cards ── */
    .stat-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }}
    .stat-card {{
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 12px;
      padding: 1.25rem;
    }}
    .stat-card__label {{ font-size: .78rem; color: var(--peck-fg-muted, #9097a8); margin-bottom: .25rem; }}
    .stat-card__value {{ font-size: 2rem; font-weight: 700; color: var(--peck-fg, #e8eaf0); }}
    .stat-card__sub {{ font-size: .75rem; color: var(--peck-fg-muted, #9097a8); margin-top: .25rem; }}

    /* ── Agent card ── */
    .agent-card {{
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 12px;
      padding: 1.25rem;
      transition: border-color .2s, transform .15s;
    }}
    .agent-card:hover {{ border-color: rgba(108,99,255,.5); transform: translateY(-2px); }}
    .agent-card__header {{ display: flex; align-items: center; gap: .75rem; margin-bottom: .75rem; }}
    .agent-card__icon {{
      width: 40px; height: 40px; border-radius: 10px;
      background: linear-gradient(135deg, #6c63ff22, #00d4aa22);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.2rem;
    }}
    .agent-card__name {{ font-weight: 600; font-size: 1rem; }}
    .agent-card__desc {{ font-size: .85rem; color: var(--peck-fg-muted, #9097a8); margin-bottom: .75rem; }}
    .agent-card__tags {{ display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: .75rem; }}
    .tag {{
      font-size: .72rem; padding: .2rem .55rem;
      border-radius: 999px;
      background: rgba(108,99,255,.15);
      color: #a09ff7;
      border: 1px solid rgba(108,99,255,.25);
    }}
    .agent-card__footer {{ display: flex; align-items: center; justify-content: space-between; }}
    .price {{ font-size: .85rem; font-weight: 600; color: var(--peck-fg, #e8eaf0); }}
    .price sub {{ font-size: .7rem; color: var(--peck-fg-muted, #9097a8); font-weight: 400; }}

    /* ── Status badge ── */
    .status-dot {{
      display: inline-flex; align-items: center; gap: .35rem;
      font-size: .75rem;
    }}
    .status-dot__circle {{
      width: 7px; height: 7px; border-radius: 50%;
    }}
    .status-dot--online .status-dot__circle {{ background: #22c55e; box-shadow: 0 0 6px #22c55e88; }}
    .status-dot--offline .status-dot__circle {{ background: #6b7280; }}

    /* ── TX Feed ── */
    .tx-table {{ width: 100%; border-collapse: collapse; }}
    .tx-table th {{
      text-align: left; padding: .6rem .75rem;
      font-size: .75rem; color: var(--peck-fg-muted, #9097a8);
      border-bottom: 1px solid rgba(255,255,255,.08);
      text-transform: uppercase; letter-spacing: .06em;
    }}
    .tx-table td {{
      padding: .6rem .75rem;
      font-size: .82rem;
      border-bottom: 1px solid rgba(255,255,255,.05);
    }}
    .tx-table tr:hover td {{ background: rgba(255,255,255,.025); }}
    .tx-new {{ animation: fadeSlideIn .4s ease; }}
    @keyframes fadeSlideIn {{
      from {{ opacity: 0; transform: translateY(-8px); }}
      to   {{ opacity: 1; transform: translateY(0); }}
    }}
    .txid-link {{ font-family: monospace; font-size: .75rem; color: #6c63ff; text-decoration: none; }}
    .txid-link:hover {{ text-decoration: underline; }}
    .amount-sats {{ font-weight: 600; color: #00d4aa; }}

    /* ── Network graph ── */
    #network-canvas {{
      width: 100%; height: 360px;
      border-radius: 12px;
      background: rgba(255,255,255,.025);
      border: 1px solid rgba(255,255,255,.08);
      position: relative; overflow: hidden;
    }}

    /* ── Demo ── */
    .demo-cycle {{
      background: rgba(255,255,255,.035);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 12px; padding: 1.25rem;
      font-size: .85rem; margin-bottom: .75rem;
    }}
    .demo-step {{ display: flex; align-items: center; gap: .75rem; margin: .5rem 0; }}
    .demo-step__dot {{
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--peck-fg-muted, #9097a8); flex-shrink: 0;
    }}
    .demo-step--done .demo-step__dot {{ background: #22c55e; }}
    .demo-step--active .demo-step__dot {{
      background: #6c63ff;
      animation: pulse 1s infinite;
    }}
    @keyframes pulse {{
      0%, 100% {{ box-shadow: 0 0 0 0 #6c63ff66; }}
      50% {{ box-shadow: 0 0 0 5px transparent; }}
    }}

    /* ── Containers ── */
    .page {{ max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }}
    .section-title {{ font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; color: var(--peck-fg, #e8eaf0); }}
    .agent-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }}

    /* ── Buttons ── */
    .btn {{
      display: inline-flex; align-items: center; gap: .5rem;
      padding: .55rem 1.1rem; border-radius: 8px;
      font-size: .9rem; font-weight: 500; cursor: pointer;
      border: none; transition: all .15s;
    }}
    .btn--primary {{
      background: #6c63ff; color: #fff;
    }}
    .btn--primary:hover {{ background: #5a52e0; }}
    .btn--danger {{
      background: #ef4444; color: #fff;
    }}
    .btn--danger:hover {{ background: #dc2626; }}
    .btn--secondary {{
      background: rgba(255,255,255,.08); color: var(--peck-fg, #e8eaf0);
      border: 1px solid rgba(255,255,255,.12);
    }}
    .btn--secondary:hover {{ background: rgba(255,255,255,.12); }}

    /* ── Filter bar ── */
    .filter-bar {{ display: flex; gap: .75rem; margin-bottom: 1.25rem; flex-wrap: wrap; }}
    .filter-chip {{
      padding: .35rem .85rem; border-radius: 999px; font-size: .8rem;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.1);
      color: var(--peck-fg-muted, #9097a8);
      cursor: pointer; transition: all .15s;
    }}
    .filter-chip.active, .filter-chip:hover {{
      background: rgba(108,99,255,.2);
      border-color: rgba(108,99,255,.5);
      color: #a09ff7;
    }}

    /* ── Latency bar ── */
    .latency-row {{ display: flex; gap: 1.5rem; margin-top: 1rem; flex-wrap: wrap; }}
    .latency-item {{ text-align: center; }}
    .latency-item__val {{ font-size: 1.6rem; font-weight: 700; color: #6c63ff; }}
    .latency-item__label {{ font-size: .72rem; color: var(--peck-fg-muted, #9097a8); }}
  </style>
</head>
<body>
  <nav class="peck-topnav">
    <a href="/" class="peck-topnav__logo">
      <svg class="peck-icon peck-icon--sm" style="vertical-align:middle;margin-right:.35rem">
        <use href="{BASE_PATH}/peck-icons.svg#peck-coin"/>
      </svg>
      Peck Pay
    </a>
    <ul class="peck-topnav__links">
      <li><a href="/">Overview</a></li>
      <li><a href="/agents">Agents</a></li>
      <li><a href="/feed">Feed</a></li>
      <li><a href="/demo">Demo</a></li>
    </ul>
    <div class="peck-topnav__spacer"></div>
    <span id="ws-status" style="font-size:.75rem;color:#9097a8">⬤ connecting…</span>
  </nav>

  <div class="page">
    {body}
  </div>

  <script>
    // ── Global WebSocket connection ──────────────────────────────────────────
    let ws;
    const wsStatus = document.getElementById('ws-status');

    function connectWS() {{
      ws = new WebSocket(`ws://${{location.host}}/ws`);
      ws.onopen  = () => {{ wsStatus.textContent = '⬤ live'; wsStatus.style.color = '#22c55e'; }};
      ws.onclose = () => {{
        wsStatus.textContent = '⬤ offline';
        wsStatus.style.color = '#ef4444';
        setTimeout(connectWS, 3000);
      }};
      ws.onerror = () => {{ wsStatus.textContent = '⬤ error'; wsStatus.style.color = '#f97316'; }};
      ws.onmessage = (evt) => {{
        const msg = JSON.parse(evt.data);
        window.dispatchEvent(new CustomEvent('peck-event', {{ detail: msg }}));
      }};
    }}
    connectWS();
  </script>
</body>
</html>"""


def nav_active(current: str, path: str) -> str:
    return 'active' if current == path else ''


# ── Pages ─────────────────────────────────────────────────────────────────────

async def page_overview(request: Request) -> HTMLResponse:
    agents_online = sum(1 for a in state["agents"].values() if a.get("status") == "online")
    txs_today = state["stats"]["txs_today"]
    total_sats = state["stats"]["total_bsv_satoshis"]

    body = f"""
    <h1 style="font-size:1.8rem;font-weight:700;margin-bottom:.5rem">
      <svg class="peck-icon peck-icon--lg" style="vertical-align:middle;margin-right:.5rem">
        <use href="{BASE_PATH}/peck-icons.svg#peck-action"/>
      </svg>
      AI Agent Marketplace
    </h1>
    <p style="color:#9097a8;margin-bottom:2rem">
      Micropayments via BSV — no API keys, no subscriptions, no middlemen.
    </p>

    <!-- Live Stats -->
    <div class="stat-grid" id="stat-grid"
         x-data="statGrid()" x-init="init()"
         @peck-event.window="onEvent($event.detail)">
      <div class="stat-card">
        <div class="stat-card__label">Agents Online</div>
        <div class="stat-card__value" x-text="agentsOnline">{agents_online}</div>
        <div class="stat-card__sub">BRC-103 identities</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Transactions Today</div>
        <div class="stat-card__value" x-text="txsToday">{txs_today:,}</div>
        <div class="stat-card__sub">target: 1,500,000</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Total Paid (satoshis)</div>
        <div class="stat-card__value" x-text="totalSats.toLocaleString()">{total_sats:,}</div>
        <div class="stat-card__sub">≈ <span x-text="totalBsv">{ satoshis_to_bsv(total_sats) }</span> BSV</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Avg TX Fee</div>
        <div class="stat-card__value">~0.01¢</div>
        <div class="stat-card__sub">BSV tx fee: $0.0001</div>
      </div>
    </div>

    <!-- Network Graph -->
    <div class="section-title">Live Agent Network</div>
    <div id="network-canvas" x-data="networkGraph()" x-init="init()"
         @peck-event.window="onEvent($event.detail)">
      <canvas id="graph-canvas" style="width:100%;height:100%"></canvas>
    </div>

    <!-- Recent Transactions -->
    <div class="section-title" style="margin-top:2rem">Recent Transactions</div>
    <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:auto">
      <table class="tx-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>From → To</th>
            <th>Service</th>
            <th>Amount</th>
            <th>Latency</th>
            <th>TXID</th>
          </tr>
        </thead>
        <tbody id="recent-txs" x-data="txFeed(5)" x-init="init()"
               @peck-event.window="onEvent($event.detail)">
          <template x-if="txs.length === 0">
            <tr><td colspan="6" style="text-align:center;color:#9097a8;padding:2rem">
              Waiting for transactions…
            </td></tr>
          </template>
          <template x-for="tx in txs" :key="tx.txid || tx.ts">
            <tr class="tx-new">
              <td x-text="fmt(tx.ts)"></td>
              <td><span x-text="tx.from" style="color:#a09ff7"></span> → <span x-text="tx.to"></span></td>
              <td x-text="tx.service || tx.to"></td>
              <td class="amount-sats" x-text="tx.amount + ' sat'"></td>
              <td x-text="tx.latency_ms + 'ms'"></td>
              <td>
                <a :href="'https://whatsonchain.com/tx/' + tx.txid"
                   class="txid-link" target="_blank"
                   x-text="tx.txid ? tx.txid.slice(0,10)+'…' : '—'">
                </a>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <script>
      function statGrid() {{
        return {{
          agentsOnline: {agents_online},
          txsToday: {txs_today},
          totalSats: {total_sats},
          get totalBsv() {{ return (this.totalSats / 1e8).toFixed(8); }},
          init() {{}},
          onEvent(e) {{
            if (e.event === 'tx') {{
              this.txsToday++;
              this.totalSats += (e.amount || 0);
            }}
            if (e.event === 'agent_online')  this.agentsOnline++;
            if (e.event === 'agent_offline') this.agentsOnline = Math.max(0, this.agentsOnline - 1);
          }}
        }};
      }}

      function txFeed(maxRows = 5) {{
        return {{
          txs: {json.dumps(state['txs'][-5:])},
          init() {{}},
          fmt(ts) {{
            if (!ts) return '—';
            return new Date(ts).toLocaleTimeString('no');
          }},
          onEvent(e) {{
            if (e.event === 'tx') {{
              this.txs.unshift({{ ...e, ts: e.ts || Date.now() }});
              if (this.txs.length > {5}) this.txs.pop();
            }}
          }}
        }};
      }}

      function networkGraph() {{
        const nodes = {{}};
        const edges = [];
        let canvas, ctx, animId;

        function rand(min, max) {{ return min + Math.random() * (max - min); }}

        function addNode(id, label) {{
          if (!nodes[id]) {{
            nodes[id] = {{
              id, label,
              x: rand(.15, .85), y: rand(.15, .85),
              vx: rand(-0.0003, 0.0003),
              vy: rand(-0.0003, 0.0003),
              pulse: 0,
            }};
          }}
        }}

        function draw() {{
          if (!canvas) return;
          const W = canvas.width, H = canvas.height;
          ctx.clearRect(0, 0, W, H);

          // Draw edges
          edges.slice(-20).forEach(e => {{
            const a = nodes[e.from], b = nodes[e.to];
            if (!a || !b) return;
            ctx.beginPath();
            ctx.moveTo(a.x * W, a.y * H);
            ctx.lineTo(b.x * W, b.y * H);
            const age = (Date.now() - e.ts) / 2000;
            const alpha = Math.max(0, 1 - age);
            ctx.strokeStyle = `rgba(108,99,255,${{alpha * .6}})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }});

          // Draw nodes
          Object.values(nodes).forEach(n => {{
            n.x = Math.max(.05, Math.min(.95, n.x + n.vx));
            n.y = Math.max(.05, Math.min(.95, n.y + n.vy));
            if (n.x < .05 || n.x > .95) n.vx *= -1;
            if (n.y < .05 || n.y > .95) n.vy *= -1;

            const px = n.x * W, py = n.y * H;
            const r = 7;

            // Pulse ring
            if (n.pulse > 0) {{
              ctx.beginPath();
              ctx.arc(px, py, r + 12 * (1 - n.pulse), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(108,99,255,${{n.pulse * .7}})`;
              ctx.lineWidth = 2;
              ctx.stroke();
              n.pulse = Math.max(0, n.pulse - 0.03);
            }}

            // Node
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = '#6c63ff';
            ctx.fill();

            // Label
            ctx.font = '11px system-ui';
            ctx.fillStyle = 'rgba(232,234,240,.8)';
            ctx.textAlign = 'center';
            ctx.fillText(n.label, px, py + r + 12);
          }});

          animId = requestAnimationFrame(draw);
        }}

        return {{
          init() {{
            canvas = document.getElementById('graph-canvas');
            if (!canvas) return;
            ctx = canvas.getContext('2d');
            const resize = () => {{
              canvas.width  = canvas.offsetWidth;
              canvas.height = canvas.offsetHeight;
            }};
            resize();
            new ResizeObserver(resize).observe(canvas);
            draw();

            // Seed with known agents
            {json.dumps([{"id": k, "name": v.get("name", k)} for k, v in state["agents"].items()])}.forEach(a => {{
              addNode(a.id, a.name || a.id);
            }});
          }},
          onEvent(e) {{
            if (e.event === 'tx') {{
              addNode(e.from, e.from);
              addNode(e.to, e.to);
              edges.push({{ from: e.from, to: e.to, ts: Date.now() }});
              if (edges.length > 50) edges.shift();
              if (nodes[e.from]) nodes[e.from].pulse = 1;
              if (nodes[e.to])   nodes[e.to].pulse   = 1;
            }}
            if (e.event === 'agent_online') {{
              addNode(e.id, e.id);
            }}
          }}
        }};
      }}
    </script>
    """
    return HTMLResponse(html_page("Overview", body))


async def page_agents(request: Request) -> HTMLResponse:
    agents = list(state["agents"].values())
    if not agents:
        # Show placeholder cards so the page isn't empty
        agents = [
            {"id": "translate-agent", "name": "Translate Agent", "description": "Translates text between 50+ languages.", "capabilities": ["translate", "nlp"], "price": 500, "status": "online"},
            {"id": "weather-agent", "name": "Weather Agent", "description": "Realtime weather data via on-chain oracle.", "capabilities": ["weather", "oracle"], "price": 100, "status": "online"},
            {"id": "summarize-agent", "name": "Summarize Agent", "description": "Summarizes long text with AI.", "capabilities": ["summarize", "nlp"], "price": 300, "status": "offline"},
        ]

    cards_html = ""
    for a in agents:
        status = a.get("status", "offline")
        status_color = "#22c55e" if status == "online" else "#6b7280"
        caps = a.get("capabilities", [])
        tags = "".join(f'<span class="tag">{c}</span>' for c in caps)
        price = a.get("price", 0)
        icon_map = {"translate": "🌐", "weather": "⛅", "summarize": "📝", "oracle": "🔮", "compute": "💻"}
        icon = next((icon_map[c] for c in caps if c in icon_map), "🤖")
        cards_html += f"""
        <div class="agent-card" x-data="{{}}" id="agent-{a['id']}">
          <div class="agent-card__header">
            <div class="agent-card__icon">{icon}</div>
            <div>
              <div class="agent-card__name">{a.get('name', a['id'])}</div>
              <div class="status-dot status-dot--{status}">
                <span class="status-dot__circle"></span>
                <span style="color:{status_color}">{status}</span>
              </div>
            </div>
          </div>
          <div class="agent-card__desc">{a.get('description', 'AI microservice')}</div>
          <div class="agent-card__tags">{tags}</div>
          <div class="agent-card__footer">
            <div class="price">{price} sat <sub>per call</sub></div>
            <a href="/agent/{a['id']}" class="btn btn--secondary" style="font-size:.8rem;padding:.35rem .75rem">Details →</a>
          </div>
        </div>
        """

    body = f"""
    <h1 style="font-size:1.6rem;font-weight:700;margin-bottom:.5rem">Agent Catalog</h1>
    <p style="color:#9097a8;margin-bottom:1.5rem">
      {len(agents)} services available. Pay per call — no subscriptions.
    </p>

    <div class="filter-bar" x-data="agentFilter()" x-init="init()"
         @peck-event.window="onEvent($event.detail)">
      <button class="filter-chip" :class="{{ active: cap === '' }}"
              @click="cap = ''" >All</button>
      <button class="filter-chip" :class="{{ active: cap === 'nlp' }}"
              @click="cap = 'nlp'">NLP</button>
      <button class="filter-chip" :class="{{ active: cap === 'weather' }}"
              @click="cap = 'weather'">Weather</button>
      <button class="filter-chip" :class="{{ active: cap === 'oracle' }}"
              @click="cap = 'oracle'">Oracle</button>
      <button class="filter-chip" :class="{{ active: cap === 'compute' }}"
              @click="cap = 'compute'">Compute</button>
      <span style="flex:1"></span>
      <span style="font-size:.8rem;color:#9097a8" x-text="online + ' online'"></span>
    </div>

    <div class="agent-grid" id="agents-grid">
      {cards_html}
    </div>

    <script>
      function agentFilter() {{
        return {{
          cap: '',
          online: {sum(1 for a in agents if a.get('status') == 'online')},
          init() {{
            this.$watch('cap', v => {{
              document.querySelectorAll('.agent-card').forEach(card => {{
                const tags = Array.from(card.querySelectorAll('.tag')).map(t => t.textContent);
                card.style.display = (!v || tags.includes(v)) ? '' : 'none';
              }});
            }});
          }},
          onEvent(e) {{
            if (e.event === 'agent_online')  this.online++;
            if (e.event === 'agent_offline') this.online = Math.max(0, this.online - 1);
          }}
        }};
      }}
    </script>
    """
    return HTMLResponse(html_page("Agents", body))


async def page_feed(request: Request) -> HTMLResponse:
    txs = list(reversed(state["txs"][-100:]))  # newest first

    rows_html = ""
    for tx in txs:
        txid = tx.get("txid", "")
        txid_short = txid[:10] + "…" if txid else "—"
        ts = tx.get("ts", 0)
        from collections import namedtuple
        import datetime
        try:
            t = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
        except Exception:
            t = "—"
        rows_html += f"""
        <tr>
          <td>{t}</td>
          <td><span style="color:#a09ff7">{tx.get('from','—')}</span> → {tx.get('to','—')}</td>
          <td>{tx.get('service', tx.get('to', '—'))}</td>
          <td class="amount-sats">{tx.get('amount',0)} sat</td>
          <td>{tx.get('latency_ms', '—')}ms</td>
          <td><a href="https://whatsonchain.com/tx/{txid}" class="txid-link" target="_blank">{txid_short}</a></td>
        </tr>
        """

    body = f"""
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
      <div>
        <h1 style="font-size:1.6rem;font-weight:700;margin-bottom:.25rem">Live Transaction Feed</h1>
        <p style="color:#9097a8">Real-time BSV micropayments between agents.</p>
      </div>
    </div>

    <!-- Cumulative stats -->
    <div class="stat-grid" style="margin-bottom:1.5rem"
         x-data="feedStats()" x-init="init()" @peck-event.window="onEvent($event.detail)">
      <div class="stat-card">
        <div class="stat-card__label">Total Transactions</div>
        <div class="stat-card__value" x-text="total.toLocaleString()">{state['stats']['txs_today']:,}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Total Satoshis Moved</div>
        <div class="stat-card__value" x-text="totalSats.toLocaleString()">{state['stats']['total_bsv_satoshis']:,}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Avg Latency</div>
        <div class="stat-card__value" x-text="avgMs + 'ms'">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">TPS (live)</div>
        <div class="stat-card__value" x-text="tps.toFixed(1)">0.0</div>
      </div>
    </div>

    <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:auto">
      <table class="tx-table">
        <thead>
          <tr>
            <th>Time</th><th>From → To</th><th>Service</th>
            <th>Amount</th><th>Latency</th><th>TXID</th>
          </tr>
        </thead>
        <tbody id="feed-body"
               x-data="liveFeed()" x-init="init()"
               @peck-event.window="onEvent($event.detail)">
          <template x-if="txs.length === 0">
            <tr><td colspan="6" style="text-align:center;color:#9097a8;padding:2.5rem">
              Waiting for transactions from agent backend…
            </td></tr>
          </template>
          <template x-for="tx in txs" :key="tx._id">
            <tr class="tx-new">
              <td x-text="fmtTime(tx.ts)"></td>
              <td><span x-text="tx.from" style="color:#a09ff7"></span> → <span x-text="tx.to"></span></td>
              <td x-text="tx.service || tx.to"></td>
              <td class="amount-sats" x-text="tx.amount + ' sat'"></td>
              <td x-text="(tx.latency_ms || '—') + 'ms'"></td>
              <td><a :href="'https://whatsonchain.com/tx/' + tx.txid"
                     class="txid-link" target="_blank"
                     x-text="tx.txid ? tx.txid.slice(0,10)+'…' : '—'"></a></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <script>
      let _feedId = 0;
      function liveFeed() {{
        return {{
          txs: {json.dumps([{{**tx, '_id': i}} for i, tx in enumerate(txs[:50])])},
          init() {{}},
          fmtTime(ts) {{
            if (!ts) return '—';
            return new Date(ts).toLocaleTimeString('no');
          }},
          onEvent(e) {{
            if (e.event !== 'tx') return;
            _feedId++;
            this.txs.unshift({{ ...e, ts: e.ts || Date.now(), _id: _feedId }});
            if (this.txs.length > 200) this.txs.pop();
          }}
        }};
      }}

      function feedStats() {{
        const tpsWindow = [];
        return {{
          total: {state['stats']['txs_today']},
          totalSats: {state['stats']['total_bsv_satoshis']},
          latencies: [],
          get avgMs() {{
            if (!this.latencies.length) return '—';
            return Math.round(this.latencies.reduce((a,b) => a+b, 0) / this.latencies.length);
          }},
          tps: 0,
          init() {{
            setInterval(() => {{
              const now = Date.now();
              const recent = tpsWindow.filter(t => now - t < 10000);
              tpsWindow.splice(0, tpsWindow.length, ...recent);
              this.tps = recent.length / 10;
            }}, 1000);
          }},
          onEvent(e) {{
            if (e.event !== 'tx') return;
            this.total++;
            this.totalSats += (e.amount || 0);
            if (e.latency_ms) this.latencies.push(e.latency_ms);
            if (this.latencies.length > 100) this.latencies.shift();
            tpsWindow.push(Date.now());
          }}
        }};
      }}
    </script>
    """
    return HTMLResponse(html_page("Live Feed", body))


async def page_agent_detail(request: Request) -> HTMLResponse:
    agent_id = request.path_params.get("id", "")
    agent = state["agents"].get(agent_id) or {
        "id": agent_id,
        "name": agent_id,
        "status": "unknown",
        "capabilities": [],
        "price": 0,
        "description": "Agent details will appear here when the agent connects.",
    }

    agent_txs = [t for t in state["txs"] if t.get("from") == agent_id or t.get("to") == agent_id]
    total_vol = sum(t.get("amount", 0) for t in agent_txs)
    avg_lat = (sum(t.get("latency_ms", 0) for t in agent_txs) // len(agent_txs)) if agent_txs else 0
    caps = agent.get("capabilities", [])
    tags = "".join(f'<span class="tag">{c}</span>' for c in caps)
    status = agent.get("status", "offline")

    rows = ""
    for tx in reversed(agent_txs[-20:]):
        txid = tx.get("txid", "")
        rows += f"""<tr>
          <td style="font-family:monospace;font-size:.78rem">{tx.get('from','')}</td>
          <td style="font-family:monospace;font-size:.78rem">{tx.get('to','')}</td>
          <td class="amount-sats">{tx.get('amount',0)} sat</td>
          <td>{tx.get('latency_ms','—')}ms</td>
          <td><a href="https://whatsonchain.com/tx/{txid}" class="txid-link" target="_blank">
            {txid[:10]+'…' if txid else '—'}</a></td>
        </tr>"""

    body = f"""
    <a href="/agents" style="color:#9097a8;font-size:.85rem;text-decoration:none">← Back to catalog</a>

    <div style="display:flex;gap:1.5rem;margin:1.5rem 0;flex-wrap:wrap">
      <div style="flex:1;min-width:260px">
        <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
          <div class="agent-card__icon" style="width:52px;height:52px;font-size:1.6rem">🤖</div>
          <div>
            <h1 style="font-size:1.4rem;font-weight:700;margin:0">{agent.get('name', agent_id)}</h1>
            <div class="status-dot status-dot--{status}" style="margin-top:.25rem">
              <span class="status-dot__circle"></span>
              <span>{status}</span>
            </div>
          </div>
        </div>
        <p style="color:#9097a8;font-size:.9rem">{agent.get('description','')}</p>
        <div class="agent-card__tags">{tags}</div>
        <div style="font-size:.85rem;margin-top:.75rem">
          <strong>{agent.get('price',0)} satoshis</strong> per call
        </div>
      </div>

      <div style="flex:1;min-width:260px">
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-card__label">Calls Seen</div>
            <div class="stat-card__value">{len(agent_txs)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Volume (sat)</div>
            <div class="stat-card__value">{total_vol:,}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Avg Latency</div>
            <div class="stat-card__value">{avg_lat}ms</div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title">Transaction History (last 20)</div>
    <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:auto">
      <table class="tx-table">
        <thead>
          <tr><th>From</th><th>To</th><th>Amount</th><th>Latency</th><th>TXID</th></tr>
        </thead>
        <tbody id="agent-txs">
          {"<tr><td colspan='5' style='text-align:center;color:#9097a8;padding:2rem'>No transactions yet</td></tr>" if not rows else rows}
        </tbody>
      </table>
    </div>
    """
    return HTMLResponse(html_page(f"Agent: {agent.get('name', agent_id)}", body))


async def page_demo(request: Request) -> HTMLResponse:
    body = f"""
    <h1 style="font-size:1.6rem;font-weight:700;margin-bottom:.5rem">Demo Mode</h1>
    <p style="color:#9097a8;margin-bottom:2rem">
      Trigger a live demo: client agent calls service agents and pays via BSV.
    </p>

    <div style="max-width:700px"
         x-data="demoController()" x-init="init()"
         @peck-event.window="onEvent($event.detail)">

      <!-- Start/Stop -->
      <div style="display:flex;gap:1rem;margin-bottom:2rem">
        <button class="btn btn--primary" @click="startDemo()"
                :disabled="running" :style="running ? 'opacity:.5' : ''">
          ▶ Start Demo
        </button>
        <button class="btn btn--danger" @click="stopDemo()"
                x-show="running">
          ■ Stop
        </button>
        <button class="btn btn--secondary" @click="triggerOne()"
                :disabled="running">
          ↺ Single Call
        </button>
      </div>

      <!-- Cycle visualizer -->
      <div class="section-title" x-show="cycle.length > 0">HTTP 402 → Pay → Deliver Cycle</div>
      <div class="demo-cycle" x-show="cycle.length > 0">
        <template x-for="(step, i) in cycle" :key="i">
          <div class="demo-step"
               :class="{{ 'demo-step--done': step.done, 'demo-step--active': step.active }}">
            <div class="demo-step__dot"></div>
            <span x-text="step.label"></span>
            <span x-show="step.ms" x-text="' — ' + step.ms + 'ms'"
                  style="color:#9097a8;font-size:.8rem;margin-left:.25rem"></span>
          </div>
        </template>
      </div>

      <!-- Latency breakdown -->
      <div x-show="latency.zeta || latency.broadcast || latency.confirm">
        <div class="section-title">Timing Breakdown</div>
        <div class="latency-row">
          <div class="latency-item">
            <div class="latency-item__val" x-text="latency.zeta ? latency.zeta + 'ms' : '—'">—</div>
            <div class="latency-item__label">Zeta signing</div>
          </div>
          <div class="latency-item">
            <div class="latency-item__val" x-text="latency.broadcast ? latency.broadcast + 'ms' : '—'">—</div>
            <div class="latency-item__label">ARC broadcast</div>
          </div>
          <div class="latency-item">
            <div class="latency-item__val" x-text="latency.confirm ? latency.confirm + 'ms' : '—'">—</div>
            <div class="latency-item__label">Network confirm</div>
          </div>
          <div class="latency-item">
            <div class="latency-item__val" x-text="latency.total ? latency.total + 'ms' : '—'">—</div>
            <div class="latency-item__label">Total</div>
          </div>
        </div>
      </div>

      <!-- Recent demo calls -->
      <div class="section-title" style="margin-top:2rem" x-show="calls.length > 0">Demo Calls</div>
      <template x-for="c in calls" :key="c.id">
        <div class="demo-cycle" style="margin-bottom:.5rem">
          <div style="display:flex;justify-content:space-between;margin-bottom:.35rem">
            <strong x-text="c.from + ' → ' + c.to" style="font-size:.85rem"></strong>
            <span x-text="c.amount + ' sat'" class="amount-sats" style="font-size:.85rem"></span>
          </div>
          <div style="display:flex;gap:1rem;font-size:.78rem;color:#9097a8">
            <span x-text="c.latency_ms + 'ms latency'"></span>
            <a :href="'https://whatsonchain.com/tx/' + c.txid"
               x-show="c.txid" class="txid-link" target="_blank"
               x-text="c.txid ? 'TXID: ' + c.txid.slice(0,12)+'…' : ''"></a>
          </div>
        </div>
      </template>
    </div>

    <script>
      function demoController() {{
        let demoInterval = null;
        let callId = 0;
        return {{
          running: false,
          cycle: [],
          latency: {{}},
          calls: [],
          init() {{
            this.resetCycle();
          }},
          resetCycle() {{
            this.cycle = [
              {{ label: 'Client requests service', done: false, active: false }},
              {{ label: 'Service returns HTTP 402 Payment Required', done: false, active: false, ms: null }},
              {{ label: 'Client pays: Zeta signs BSV transaction', done: false, active: false, ms: null }},
              {{ label: 'Client retries with payment TXID header', done: false, active: false, ms: null }},
              {{ label: 'ARC broadcasts to network', done: false, active: false, ms: null }},
              {{ label: 'Service delivers result', done: false, active: false, ms: null }},
            ];
          }},
          startDemo() {{
            this.running = true;
            fetch('/api/demo/start', {{ method: 'POST' }}).catch(() => {{}});
          }},
          stopDemo() {{
            this.running = false;
            fetch('/api/demo/stop', {{ method: 'POST' }}).catch(() => {{}});
            clearInterval(demoInterval);
          }},
          triggerOne() {{
            fetch('/api/demo/trigger', {{ method: 'POST' }}).catch(() => {{}});
          }},
          onEvent(e) {{
            if (e.event === 'tx') {{
              callId++;
              this.calls.unshift({{ ...e, id: callId }});
              if (this.calls.length > 10) this.calls.pop();

              // Animate cycle
              this.resetCycle();
              const steps = [0, 1, 2, 3, 4, 5];
              let i = 0;
              const next = () => {{
                if (i > 0) {{
                  this.cycle[i-1].active = false;
                  this.cycle[i-1].done = true;
                }}
                if (i < steps.length) {{
                  this.cycle[i].active = true;
                  i++;
                  setTimeout(next, 180 + Math.random() * 120);
                }}
              }};
              next();

              // Latency breakdown
              if (e.latency_ms) {{
                this.latency = {{
                  zeta: Math.round(e.latency_ms * .008),
                  broadcast: Math.round(e.latency_ms * .15),
                  confirm: Math.round(e.latency_ms * .6),
                  total: e.latency_ms,
                }};
              }}
            }}
            if (e.event === 'demo_started') this.running = true;
            if (e.event === 'demo_stopped')  this.running = false;
          }}
        }};
      }}
    </script>
    """
    return HTMLResponse(html_page("Demo", body))


# ── WebSocket Endpoints ────────────────────────────────────────────────────────

async def ws_browser(websocket: WebSocket):
    """Browser client WebSocket — relay events and initial state."""
    await websocket.accept()
    browser_clients.add(websocket)
    try:
        # Send initial state snapshot
        await websocket.send_text(json.dumps({
            "event": "snapshot",
            "agents": list(state["agents"].values()),
            "txs": state["txs"][-50:],
            "stats": state["stats"],
        }))
        # Keep alive — wait for disconnect
        while True:
            await websocket.receive_text()  # ping/keepalive from client
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        browser_clients.discard(websocket)


async def ws_backend(websocket: WebSocket):
    """TS agent backend connects here to push events."""
    await websocket.accept()
    log.info("Agent backend connected via WS")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            event = msg.get("event")

            if event == "tx":
                msg.setdefault("ts", None)
                state["txs"].append(msg)
                if len(state["txs"]) > 500:
                    state["txs"].pop(0)
                state["stats"]["txs_today"] += 1
                state["stats"]["total_bsv_satoshis"] += msg.get("amount", 0)

            elif event == "agent_online":
                aid = msg.get("id")
                if aid:
                    state["agents"][aid] = {
                        "id": aid,
                        "name": msg.get("name", aid),
                        "capabilities": msg.get("capabilities", []),
                        "price": msg.get("price", 0),
                        "status": "online",
                        "lastSeen": msg.get("ts"),
                    }
                    state["stats"]["agents_online"] = sum(
                        1 for a in state["agents"].values() if a.get("status") == "online"
                    )

            elif event == "agent_offline":
                aid = msg.get("id")
                if aid and aid in state["agents"]:
                    state["agents"][aid]["status"] = "offline"
                    state["stats"]["agents_online"] = sum(
                        1 for a in state["agents"].values() if a.get("status") == "online"
                    )

            await broadcast(msg)

    except (WebSocketDisconnect, Exception) as e:
        log.info(f"Agent backend disconnected: {e}")


# ── REST API ──────────────────────────────────────────────────────────────────

async def api_demo_start(request: Request):
    from starlette.responses import JSONResponse
    state["demo_running"] = True
    await broadcast({"event": "demo_started"})
    return JSONResponse({"ok": True})

async def api_demo_stop(request: Request):
    from starlette.responses import JSONResponse
    state["demo_running"] = False
    await broadcast({"event": "demo_stopped"})
    return JSONResponse({"ok": True})

async def api_demo_trigger(request: Request):
    """Inject a fake transaction for demo purposes."""
    from starlette.responses import JSONResponse
    import random, time
    agents = list(state["agents"].keys()) or ["client-01", "translate-agent", "weather-agent"]
    if len(agents) < 2:
        agents = ["client-01", "translate-agent", "weather-agent", "summarize-agent"]
    from_agent = random.choice(agents)
    to_agent = random.choice([a for a in agents if a != from_agent])
    tx = {
        "event": "tx",
        "from": from_agent,
        "to": to_agent,
        "service": to_agent,
        "amount": random.choice([100, 300, 500, 1000]),
        "txid": "demo" + "".join(random.choices("0123456789abcdef", k=60)),
        "latency_ms": random.randint(8, 400),
        "ts": int(time.time() * 1000),
    }
    state["txs"].append(tx)
    if len(state["txs"]) > 500:
        state["txs"].pop(0)
    state["stats"]["txs_today"] += 1
    state["stats"]["total_bsv_satoshis"] += tx["amount"]
    await broadcast(tx)
    return JSONResponse({"ok": True, "tx": tx})


async def api_stats(request: Request):
    from starlette.responses import JSONResponse
    return JSONResponse({
        **state["stats"],
        "agents": list(state["agents"].values()),
        "recent_txs": state["txs"][-20:],
    })


# ── App ───────────────────────────────────────────────────────────────────────

# Locate peck-ui static assets
PECK_UI_STATIC = PECK_UI_PATH if PECK_UI_PATH.exists() else Path("/tmp/peck-ui-missing")

routes = [
    Route("/", page_overview),
    Route("/agents", page_agents),
    Route("/feed", page_feed),
    Route("/agent/{id}", page_agent_detail),
    Route("/demo", page_demo),
    Route("/api/stats", api_stats),
    Route("/api/demo/start", api_demo_start, methods=["POST"]),
    Route("/api/demo/stop", api_demo_stop, methods=["POST"]),
    Route("/api/demo/trigger", api_demo_trigger, methods=["POST"]),
    WebSocketRoute("/ws", ws_browser),
    WebSocketRoute("/ws/backend", ws_backend),
]

if PECK_UI_STATIC.exists():
    routes.append(Mount("/static/peck-ui", StaticFiles(directory=str(PECK_UI_STATIC)), name="peck-ui"))

app = Starlette(routes=routes)

if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=8080)
