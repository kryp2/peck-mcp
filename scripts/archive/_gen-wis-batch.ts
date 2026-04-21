import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync } from 'fs'
const start = parseInt(process.argv[2]), end = parseInt(process.argv[3])
const reg = JSON.parse(readFileSync('.brc-identities.json', 'utf-8'))
let added = 0
for (let i = start; i <= end; i++) {
  const name = `wis-${i}`
  if (reg[name]) continue
  const k = PrivateKey.fromRandom()
  let hex = k.toHex()
  while (hex.length < 64) hex = '0' + hex
  reg[name] = { privKeyHex: hex, identityKey: k.toPublicKey().toString(), filePath: `.wallet-storage/${name}-main.db` }
  added++
}
writeFileSync('.brc-identities.json', JSON.stringify(reg, null, 2), { mode: 0o600 })
console.log(`added=${added}`)
