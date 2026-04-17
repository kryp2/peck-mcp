/**
 * thematic-liker.ts — theme-dictionary rater/liker.
 *
 * Each agent has ONE theme. Polls overlay for peck.cross+peck.agents posts,
 * counts matching words from its theme's dictionary, likes (peck_like_tx) any
 * post scoring >= 3 matches.
 *
 * Cross-platform (Windows/Linux/Mac), pure Node.js + tsx. No external deps.
 *
 * Usage:
 *   npx tsx scripts/thematic-liker.ts <agent> <theme>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const AGENT = process.argv[2]
const THEME = (process.argv[3] || '').toLowerCase()
if (!AGENT || !THEME) { console.error('need <agent> <theme>'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_DIR = '.thematic-liker-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'
const MIN_BALANCE = 200
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10)
const MIN_MATCHES = parseInt(process.env.MIN_MATCHES || '3', 10)

// Theme dictionaries — 40 themes, 15-25 words each
const THEMES: Record<string, string[]> = {
  love:        ['love','loved','loves','loving','beloved','affection','cherish','devoted','tender','heart','passion','adore','dear','fondness','kindness','care','warmth'],
  hope:        ['hope','hoped','hoping','hopeful','expect','await','faith','believe','promise','future','dream','anticipate','trust','confidence','yearn','longing'],
  fear:        ['fear','afraid','terror','dread','panic','tremble','frightened','scared','anxious','worry','horror','alarm','shiver','quake','terrify','phobia','dismay'],
  wisdom:      ['wisdom','wise','prudent','knowledge','understanding','discern','insight','shrewd','teach','learn','counsel','advice','sage','instruction','proverb','thoughtful'],
  prayer:      ['pray','prayed','prayer','praying','intercede','beseech','supplication','petition','worship','meditate','invocation','plead','call upon','seek','kneel','altar'],
  justice:     ['justice','just','righteous','judgement','judge','fair','equity','integrity','uprightness','verdict','law','tribunal','testify','witness','truth','honesty'],
  mercy:       ['mercy','merciful','compassion','pity','kindness','forgive','spared','gracious','tender','leniency','clemency','relent','pardon','forbearance','gentle'],
  strength:    ['strength','strong','mighty','power','powerful','valiant','courage','firm','bold','resilient','fortitude','endure','stalwart','robust','sturdy','vigor'],
  home:        ['home','house','dwell','dwelling','abode','household','family','belong','shelter','haven','residence','reside','homeland','native','lodge','tent','hearth'],
  patience:    ['patience','patient','wait','waiting','endure','perseverance','bear','slow','steadfast','longsuffering','tolerance','forbearance','calm','serene'],
  faith:       ['faith','believe','believed','trust','trusted','faithful','belief','confidence','conviction','creed','devotion','loyal','steadfast','allegiance','reliance'],
  doubt:       ['doubt','doubted','question','uncertain','skeptic','wavering','disbelieve','suspect','hesitate','mistrust','perplexed','puzzled','unsure','waver'],
  grace:       ['grace','gracious','favor','unmerited','blessing','gift','divine','mercy','charity','kindness','benediction','boon','benevolence','gentle','elegant'],
  forgiveness: ['forgive','forgiven','forgiving','pardon','absolve','release','redemption','atonement','clemency','repent','reconcile','peace','mercy','grace'],
  truth:       ['truth','truthful','true','fact','honest','verity','veracity','real','authentic','genuine','sincere','trustworthy','candor','reveal','disclose'],
  light:       ['light','shining','bright','radiance','illuminate','dawn','sunrise','glow','luminous','beam','ray','lamp','torch','brilliance','clarity','luminescent'],
  creation:    ['create','created','creation','maker','formed','shaped','genesis','origin','begin','beginning','earth','heaven','world','nature','universe','design'],
  rest:        ['rest','rested','sleep','sabbath','quiet','stillness','repose','pause','tranquil','peaceful','calm','leisure','relax','cease','stillness','refreshment'],
  praise:      ['praise','praised','worship','glory','exalt','magnify','honor','extol','bless','celebrate','acclaim','laud','hallelujah','adore','tribute','sing'],
  victory:     ['victory','victor','triumph','conquer','defeat','overcome','prevail','win','victorious','champion','success','vanquish','subdue','master','rout'],
  tears:       ['tears','weep','weeping','cry','crying','mourn','mourning','grief','sorrow','lament','sob','anguish','sadness','despair','pained','wailing'],
  courage:     ['courage','brave','bravery','valiant','bold','fearless','heroic','daring','gallant','intrepid','nerve','stout','undaunted','dauntless','resolute'],
  gratitude:   ['thank','thanks','thanksgiving','grateful','gratitude','appreciate','blessed','owe','indebted','recognition','acknowledge','praise'],
  humility:    ['humble','humility','meek','lowly','modest','unpretentious','servant','submit','submissive','deferential','unassuming','contrite','simple'],
  vision:      ['vision','see','seen','behold','look','gaze','sight','perceive','foresee','revelation','prophet','prophecy','envision','glimpse','regard','observe'],
  quiet:       ['quiet','silence','silent','still','hush','calm','stillness','whisper','murmur','soft','muted','tranquil','peaceful','serene','mute'],
  awe:         ['awe','wonder','marvel','amazement','astound','astonish','fear','reverence','trembling','overwhelm','majesty','mystery','sublime','dread'],
  exile:       ['exile','exiled','banish','foreign','stranger','alien','pilgrim','sojourn','scatter','dispersion','captivity','diaspora','wander','homeless','refugee'],
  return:      ['return','returned','homecoming','restore','restored','rebuild','recover','come back','reunite','reconcile','reclaim','regain','revive','renewal'],
  peace:       ['peace','peaceful','shalom','tranquil','calm','serenity','harmony','concord','accord','reconcile','pacify','quiet','rest','soothe'],
  blessing:    ['bless','blessed','blessing','benediction','consecrate','sanctify','hallow','favor','anoint','ordain','grace','prosper','enrich'],
  war:         ['war','battle','fight','fighting','army','warrior','sword','spear','shield','conflict','combat','enemy','foe','siege','slay','conquer'],
  journey:     ['journey','travel','traveling','wander','path','way','road','trek','pilgrimage','voyage','trip','sojourn','march','expedition','route'],
  mountain:    ['mountain','mountains','hill','peak','summit','height','Zion','Sinai','Horeb','Carmel','Tabor','Olivet','high','tall','cliff'],
  bread:       ['bread','loaf','manna','feed','fed','food','eat','ate','eating','sustenance','wheat','flour','baked','break','supper'],
  wine:        ['wine','vine','vineyard','grape','grapes','cup','drink','banquet','feast','chalice','press','new wine','tavern','libation','thirst'],
  family:      ['family','father','mother','son','daughter','brother','sister','child','children','parent','ancestor','lineage','tribe','clan','kin','relative'],
  time:        ['time','day','days','year','years','season','generation','age','eternity','forever','moment','hour','until','yesterday','tomorrow','soon','always'],
  freedom:     ['freedom','free','liberty','release','deliver','delivered','redeem','redemption','loose','unbound','emancipate','liberate','set free','escape'],
  peace2:      ['peace','peaceful','shalom','tranquil','calm','serenity','harmony'],  // extra slot for 40
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'thematic-liker', version: '1' } } }),
  })
  mcpSession = r.headers.get('mcp-session-id') || ''
  if (!mcpSession) throw new Error('mcp session')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
}
async function mcpCall(name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) {
    try { await mcpInit() } catch {}
    const r2 = await fetch(MCP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
    })
    const raw2 = await r2.text()
    const line2 = raw2.split('\n').find(l => l.startsWith('data: '))
    if (!line2) throw new Error('no data after reinit')
    const parsed2 = JSON.parse(line2.slice(6))
    if (parsed2.error) throw new Error(`mcp: ${JSON.stringify(parsed2.error).slice(0, 120)}`)
    return JSON.parse(parsed2.result.content[0].text)
  }
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}

function pickSlot(state: AgentState): { utxo: Utxo; slot: number } | null {
  const n = state.utxos.length
  let idx = state.index || 0
  for (let i = 0; i < n; i++) {
    const slot = (idx + i) % n
    const u = state.utxos[slot]
    if (u && u.satoshis >= MIN_BALANCE) { state.index = (slot + 1) % n; return { utxo: u, slot } }
  }
  return null
}

function countMatches(content: string, words: string[]): number {
  const lower = content.toLowerCase()
  let count = 0
  for (const w of words) {
    // word boundary match
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(lower)) count++
  }
  return count
}

async function fetchCandidates(offset: number, app: string): Promise<Array<{ txid: string; content: string }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${app}&type=reply&limit=100&offset=${offset}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) return []
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({ txid: p.txid, content: String(p.content || '') }))
}

async function likeTx(targetTxid: string, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_like_tx', {
        target_txid: targetTxid,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || res.error || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        if (/target_txid|required/.test(s)) { return null }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

async function main() {
  const words = THEMES[THEME]
  if (!words) { console.error(`unknown theme "${THEME}". Valid: ${Object.keys(THEMES).join(',')}`); process.exit(1) }

  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const liked: Record<string, string> = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : {}

  await mcpInit()
  console.log(`[thematic-liker] ${AGENT} theme=${THEME} words=${words.length} already-liked=${Object.keys(liked).length}`)

  let ok = 0, skipped = 0
  const start = Date.now()
  let appCycle = 0

  while (true) {
    const app = appCycle++ % 2 === 0 ? 'peck.cross' : 'peck.agents'
    const offset = Math.floor(Math.random() * 500)
    let posts: Array<{ txid: string; content: string }> = []
    try { posts = await fetchCandidates(offset, app) } catch {}

    const candidates = posts.filter(p => !liked[p.txid])
      .map(p => ({ ...p, score: countMatches(p.content, words) }))
      .filter(p => p.score >= MIN_MATCHES)

    if (candidates.length === 0) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      continue
    }

    console.log(`  ${candidates.length} candidates match "${THEME}" (app=${app} offset=${offset})`)

    for (const p of candidates) {
      const tx = await likeTx(p.txid, state)
      if (tx) {
        liked[p.txid] = tx
        ok++
        if (ok % 10 === 0) {
          writeFileSync(STATE_PATH, JSON.stringify(liked))
          const elapsed = (Date.now() - start) / 1000
          console.log(`  liked ${ok}  tps=${(ok/elapsed).toFixed(2)}  last=${p.txid.slice(0,12)} score=${p.score}`)
        }
      } else { skipped++ }
    }
    writeFileSync(STATE_PATH, JSON.stringify(liked))
  }
}

main().catch(e => { console.error('[thematic-liker] FAIL:', e.message || e); process.exit(1) })
