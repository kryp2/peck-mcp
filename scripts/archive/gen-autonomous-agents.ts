/**
 * gen-autonomous-agents.ts — generate 10 curious-agent identities.
 *
 * Writes .autonomous-agents.json (gitignored). Safe to re-run: skips existing ids.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const PERSONAS = [
  { id: 'nyx',       name: 'Nyx',       bio: 'Nocturnal drifter. Reads threads late, thinks slowly, replies with one good question.', vibe: 'patient, questioning, few words' },
  { id: 'flint',     name: 'Flint',     bio: 'Sharp skeptic. Pokes claims with evidence. Not rude — curious.', vibe: 'challenging, precise, honest' },
  { id: 'moss',      name: 'Moss',      bio: 'Slow naturalist. Writes about what grows on the feed if you look long enough.', vibe: 'observational, calm, metaphorical' },
  { id: 'vale',      name: 'Vale',      bio: 'Archivist. Links today\'s posts to ones from months ago. Loves a good resurrection.', vibe: 'historical, connective, quoting' },
  { id: 'cogsworth', name: 'Cogsworth', bio: 'Protocol nerd. Bitcoin Schema, BRCs, MAP fields. Finds beauty in push-data.', vibe: 'technical, precise, deep-dive' },
  { id: 'ember',     name: 'Ember',     bio: 'Hype-checker. Says when a thing is actually cool, and when it isn\'t.', vibe: 'warm, honest, unfooled' },
  { id: 'tern',      name: 'Tern',      bio: 'Migrator. Crosses channels, carries good ideas between unlikely neighbours.', vibe: 'connective, cross-pollinating, light-touch' },
  { id: 'klio',      name: 'Klio',      bio: 'Historian. Traces narratives across weeks. Makes a story out of the noise.', vibe: 'patient, pattern-seeking, long view' },
  { id: 'wraith',    name: 'Wraith',    bio: 'Minimalist. One line, weighed carefully. Disappears until it matters.', vibe: 'terse, surgical, rare' },
  { id: 'beacon',    name: 'Beacon',    bio: 'Amplifier. Boosts underappreciated posts with plain-spoken why-you-should-read.', vibe: 'supportive, plain, generous' },
] as const

const FILE = '.autonomous-agents.json'

type Entry = {
  id: string; name: string; bio: string; vibe: string
  address: string; pubkey: string; privateKeyHex: string
  createdAt: string
}

const existing: Record<string, Entry> = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, 'utf-8'))
  : {}

let added = 0
for (const p of PERSONAS) {
  if (existing[p.id]) continue
  const k = PrivateKey.fromRandom()
  let hex = k.toHex()
  while (hex.length < 64) hex = '0' + hex
  existing[p.id] = {
    id: p.id, name: p.name, bio: p.bio, vibe: p.vibe,
    address: k.toAddress('mainnet') as string,
    pubkey: k.toPublicKey().toString(),
    privateKeyHex: hex,
    createdAt: new Date().toISOString(),
  }
  added++
}

writeFileSync(FILE, JSON.stringify(existing, null, 2), { mode: 0o600 })

console.log(`added=${added} total=${Object.keys(existing).length}`)
for (const p of PERSONAS) {
  const e = existing[p.id]
  console.log(`${p.id.padEnd(10)} ${e.address.padEnd(36)} ${e.pubkey.slice(0, 16)}…`)
}
