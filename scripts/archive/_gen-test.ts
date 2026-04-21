import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync } from 'fs'
const reg = JSON.parse(readFileSync('.brc-identities.json', 'utf-8'))
const name = 'test-completer-01'
if (!reg[name]) {
  const k = PrivateKey.fromRandom()
  let hex = k.toHex()
  while (hex.length < 64) hex = '0' + hex
  reg[name] = { privKeyHex: hex, identityKey: k.toPublicKey().toString(), filePath: `.wallet-storage/${name}-main.db` }
  writeFileSync('.brc-identities.json', JSON.stringify(reg, null, 2), { mode: 0o600 })
  console.log('created', name)
} else console.log('exists', name)
