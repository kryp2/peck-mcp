import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync } from 'fs'
const file = '.brc-identities.json'
const reg = JSON.parse(readFileSync(file, 'utf-8'))
const START = 141, END = 340
let added = 0
for (let i = START; i <= END; i++) {
  const name = `cls-${i}`
  if (reg[name]) continue
  const k = PrivateKey.fromRandom()
  let hex = k.toHex()
  while (hex.length < 64) hex = '0' + hex
  reg[name] = { privKeyHex: hex, identityKey: k.toPublicKey().toString(), filePath: `.wallet-storage/${name}-main.db` }
  added++
}
writeFileSync(file, JSON.stringify(reg, null, 2), { mode: 0o600 })
console.log(`added=${added} total_cls=${Object.keys(reg).filter(k=>k.startsWith('cls-')).length}`)
