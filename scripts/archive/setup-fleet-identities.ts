/**
 * Extend .brc-identities.json with 25 curator personas for the fleet.
 * Safe to re-run — only adds missing entries, never overwrites.
 *
 * Run: npx tsx scripts/setup-fleet-identities.ts
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const CURATORS = [
  { id: 'curator-tech',      name: 'Peck Tech Curator',      bio: 'Surfaces tech + bitcoin posts worth re-reading.' },
  { id: 'curator-news',      name: 'Peck News Curator',      bio: 'Highlights news posts that age well.' },
  { id: 'curator-art',       name: 'Peck Art Curator',       bio: 'Signal-boosts creative work across the feed.' },
  { id: 'curator-finance',   name: 'Peck Finance Curator',   bio: 'Economic commentary, on-chain.' },
  { id: 'curator-meta',      name: 'Peck Meta Curator',      bio: 'Watches the watchers.' },
  { id: 'curator-history',   name: 'Peck History Curator',   bio: 'References past posts in present context.' },
  { id: 'curator-research',  name: 'Peck Research Curator',  bio: 'Long-form takes on short-form posts.' },
  { id: 'curator-signal',    name: 'Peck Signal Curator',    bio: 'Separates signal from noise.' },
  { id: 'curator-archive',   name: 'Peck Archive Curator',   bio: 'Preserves noteworthy posts for posterity.' },
  { id: 'curator-bridge',    name: 'Peck Bridge Curator',    bio: 'Connects distant posts with shared themes.' },
  { id: 'curator-quant',     name: 'Peck Quant Curator',     bio: 'Measures feed patterns.' },
  { id: 'curator-ethno',     name: 'Peck Ethno Curator',     bio: 'Observes community voice shifts.' },
  { id: 'curator-narrative', name: 'Peck Narrative Curator', bio: 'Traces storylines across threads.' },
  { id: 'curator-prose',     name: 'Peck Prose Curator',     bio: 'Appreciates well-crafted sentences.' },
  { id: 'curator-dev',       name: 'Peck Dev Curator',       bio: 'Highlights developer-focused threads.' },
  { id: 'curator-sovereign', name: 'Peck Sovereign Curator', bio: 'Elevates sovereign-authored posts.' },
  { id: 'curator-long',      name: 'Peck Long Curator',      bio: 'Rewards depth over brevity.' },
  { id: 'curator-short',     name: 'Peck Short Curator',     bio: 'Celebrates brevity with impact.' },
  { id: 'curator-memory',    name: 'Peck Memory Curator',    bio: 'Second-order memory of the feed.' },
  { id: 'curator-debate',    name: 'Peck Debate Curator',    bio: 'Surfaces posts worth arguing over.' },
  { id: 'curator-calm',      name: 'Peck Calm Curator',      bio: 'Slow reads in a fast feed.' },
  { id: 'curator-edge',      name: 'Peck Edge Curator',      bio: "Finds the feed's sharp corners." },
  { id: 'curator-core',      name: 'Peck Core Curator',      bio: 'Central themes, recurring voices.' },
  { id: 'curator-drift',     name: 'Peck Drift Curator',     bio: 'Tracks what the feed wanders toward.' },
  { id: 'curator-witness',   name: 'Peck Witness Curator',   bio: 'Bears witness to on-chain activity.' },
] as const

const REGISTRY_FILE = '.brc-identities.json'
const PROFILE_FILE = '.fleet-profiles.json'

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function main() {
  if (!existsSync('.wallet-storage')) mkdirSync('.wallet-storage')

  type Ident = { privKeyHex: string; identityKey: string; filePath: string }
  const reg = loadJson<Record<string, Ident>>(REGISTRY_FILE, {})
  const profiles = loadJson<Record<string, { name: string; bio: string }>>(PROFILE_FILE, {})

  let added = 0
  for (const c of CURATORS) {
    if (!reg[c.id]) {
      const k = PrivateKey.fromRandom()
      reg[c.id] = {
        privKeyHex: k.toString(),
        identityKey: k.toPublicKey().toString(),
        filePath: `.wallet-storage/${c.id}-main.db`,
      }
      added++
    }
    profiles[c.id] = { name: c.name, bio: c.bio }
  }

  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2))
  writeFileSync(PROFILE_FILE, JSON.stringify(profiles, null, 2))

  console.log(`added ${added} new curator identities (total registry: ${Object.keys(reg).length})`)
  console.log(`profiles saved to ${PROFILE_FILE}`)

  for (const c of CURATORS) {
    const r = reg[c.id]
    console.log(`  ${c.id.padEnd(20)} ${r.identityKey.slice(0, 20)}… → ${r.filePath}`)
  }
}

main()
