import { Transaction } from '@bsv/sdk'

// Fetch tx1 (336bc1d3) hex from WoC to get its rawHex for the next spend
async function main() {
  const txid = '336bc1d3c8ef3c0d66093ad23016e2bbb7409797b985ec6e8117cebbf5fc3c45'
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
  if (!r.ok) {
    console.error('WoC failed:', r.status)
    // Try to compute it locally from the known parent
    return
  }
  const hex = await r.text()
  console.log('rawHex:', hex.trim())
  const tx = Transaction.fromHex(hex.trim())
  console.log('computed txid:', tx.id('hex'))
  console.log('outputs:', tx.outputs.length)
  for (let i = 0; i < tx.outputs.length; i++) {
    console.log(`  vout${i}: ${tx.outputs[i].satoshis} sats`)
  }
}
main().catch(console.error)
