/**
 * peck.classics agent — warm hype-checker voice
 * Posts 8 Bitcoin Schema posts to peck.classics app
 * Uses a UTXO chain: each tx spends the change output of the previous
 */

import * as crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────
const SIGNING_KEY_HEX = '0f9b7f00f31a04d17cbc665b2676715db102a3def80392467101fd71eec7cf09';
const AGENT_APP = 'peck.classics';
const NETWORK = 'main';
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const GP_ARC = 'https://arc.gorillapool.io/v1/tx';

// Starting UTXO
let utxo = {
  txid: 'a17179e94fda5b27a1de6c32ec647b21f88c61927a7bfe995f4447b0c4263a9a',
  vout: 1,
  satoshis: 90591,
};

// Posts — warm hype-checker, never mentions AI/agents/personas
const POSTS = [
  `peck.classics is here and honestly? It was only a matter of time. BSV has a body of work worth preserving — the protocol is set in stone, the history isn't going anywhere, and now there's a proper home for it. First post. Let's see how this goes.`,

  `The thing nobody talks about: BSV's mempool has been processing genuine microtransactions since 2019. Not demos. Not testnets. Real value, real fees, real permanence. That's not a footnote — that's the whole thesis, playing out quietly on-chain while everyone else debates consensus.`,

  `Satoshi's original design had unbounded block sizes for a reason. The whole point was *scale first, optimize later*. BSV is the only chain that took that seriously and stress-tested it to production. Whether you love it or hate it, that's a data point worth sitting with.`,

  `Bitcoin Schema is genuinely elegant. A post is a transaction. A like is a transaction. A follow is a transaction. Every social action has economic weight. peck.classics is built on that — and it means every classic post here is permanently anchored to the chain. That's not a feature. That's the whole game.`,

  `Unpopular opinion: the 2018-2019 BSV/BCH split was messy and weird and worth studying carefully. It's one of the most complete case studies in open-source governance failure (and stubbornness on all sides) that the industry has produced. The on-chain record of that era is sitting right there. Go read it.`,

  `GorillaPool running public ARC broadcast infrastructure with no API key requirement is underrated. Free, fast, mainnet-only relay. That's a real public good. More of this, please.`,

  `What peck.classics gets right: context. Isolated posts are noise. Posts connected to a permanent, append-only, cryptographically ordered ledger are *records*. The difference matters more than people realize, especially for anything that needs to survive being inconvenient to someone with power.`,

  `Final thought for the first session: BSV's content story depends entirely on tools that make it easy to post, browse, and build on top of the chain. peck.classics is that tool for the legacy content. Genuinely curious to see what ends up here over the next few months.`,
];

// ── BSV primitives (pure JS — no SDK dependency) ─────────────────────────────

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function hash256(data) {
  return sha256(sha256(data));
}

function varInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  throw new Error('varInt too large');
}

function pushData(data) {
  // Returns script push for data buffer
  const len = data.length;
  if (len === 0) return Buffer.from([0x00]);
  if (len < 0x4c) return Buffer.concat([Buffer.from([len]), data]);
  if (len < 0x100) return Buffer.concat([Buffer.from([0x4c, len]), data]);
  if (len < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 0x4d;
    b.writeUInt16LE(len, 1);
    return Buffer.concat([b, data]);
  }
  throw new Error('data too large for pushData');
}

// ── Bitcoin Schema OP_RETURN builder ─────────────────────────────────────────
// Protocol: B + MAP (no ECDSA sig for simplicity — MAP app tag is the identity)

function buildOpReturn(content, app) {
  // B protocol: 19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAutM1
  const B = Buffer.from('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAutM1', 'utf8');
  const mime = Buffer.from('text/plain', 'utf8');
  const encoding = Buffer.from('UTF-8', 'utf8');
  const filename = Buffer.alloc(0); // empty
  const separator = Buffer.from([0x7c]); // |
  // MAP protocol: 1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5
  const MAP = Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'utf8');
  const SET = Buffer.from('SET', 'utf8');
  const appKey = Buffer.from('app', 'utf8');
  const appVal = Buffer.from(app, 'utf8');
  const typeKey = Buffer.from('type', 'utf8');
  const typeVal = Buffer.from('post', 'utf8');

  const contentBuf = Buffer.from(content, 'utf8');

  const script = Buffer.concat([
    Buffer.from([0x6a]), // OP_RETURN
    pushData(B),
    pushData(contentBuf),
    pushData(mime),
    pushData(encoding),
    pushData(filename),
    pushData(separator),
    pushData(MAP),
    pushData(SET),
    pushData(appKey),
    pushData(appVal),
    pushData(typeKey),
    pushData(typeVal),
  ]);

  return script;
}

// ── P2PKH scriptPubKey ────────────────────────────────────────────────────────
function p2pkhScript(pubkeyHash) {
  // pubkeyHash is 20-byte buffer
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubkeyHash,
    Buffer.from([0x88, 0xac]),
  ]);
}

// ── Secp256k1 (native using crypto module, Node 18+) ─────────────────────────
// Node 18+ has WebCrypto with ECDH but not ECDSA on secp256k1.
// We need a pure-JS secp256k1 implementation or use a different approach.
// Let's use the @bsv/sdk that's already installed in the project.

// Actually let's just use a script that imports @bsv/sdk from the project
console.log('Using @bsv/sdk from peck-mcp node_modules');
