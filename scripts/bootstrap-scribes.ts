/**
 * bootstrap-scribes.ts — generate N new scribe identities, add them to
 * .brc-identities.json. No funding yet, no wallet state yet — just keys.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-scribes.ts <count> [prefix=scribe]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'

const COUNT = parseInt(process.argv[2] || '24', 10)
const PREFIX = process.argv[3] || 'scribe'
const REGISTRY = '.brc-identities.json'

function main() {
  const reg: Record<string, { privKeyHex: string; identityKey: string; filePath: string }> =
    existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf-8')) : {}

  let added = 0
  for (let i = 1; i <= COUNT; i++) {
    const name = `${PREFIX}-${String(i).padStart(2, '0')}`
    if (reg[name]) { console.log(`  ${name}: exists, skip`); continue }
    const k = PrivateKey.fromRandom()
    const privKeyHex = k.toHex().padStart(64, '0')
    const identityKey = k.toPublicKey().toString()
    reg[name] = {
      privKeyHex,
      identityKey,
      filePath: `.wallet-storage/${name}-main.db`,
    }
    console.log(`  ${name}: ${identityKey.slice(0, 20)}…  addr=${k.toAddress('mainnet')}`)
    added++
  }

  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2))
  console.log(`\n[bootstrap-scribes] added=${added}  total_identities=${Object.keys(reg).length}`)
}

main()
