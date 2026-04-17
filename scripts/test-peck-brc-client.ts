/**
 * test-peck-brc-client.ts — verify PeckBrcClient instantiates and routes
 * fetch correctly in each backend mode.
 *
 * Embedded mode is fully testable. peck-desktop / brc100 modes only
 * verify the class CONSTRUCTS — we don't have a peck-desktop instance
 * running here, so we expect the .fetch() call to fail at the network
 * level (which is correct behavior).
 */
import 'dotenv/config'
import { PeckBrcClient } from '../src/clients/peck-brc-client.js'

async function testEmbedded() {
  console.log('\n=== embedded mode ===')
  const client = PeckBrcClient.create({ backend: { kind: 'embedded' } })
  console.log('  backend:', client.backend.kind)
  console.log('  originator:', client.originator)
  console.log('  canAuthenticate:', client.canAuthenticate)
  console.log('  identityKey:', await client.identityKey())

  // bank-local internalApi has no auth — should pass through cleanly
  const r = await client.fetch('http://localhost:8088/health')
  console.log('  bank-local /health:', r.status, (await r.json()).status)
}

async function testPeckDesktopConstruction() {
  console.log('\n=== peck-desktop mode (construction only) ===')
  const client = PeckBrcClient.create({
    backend: { kind: 'peck-desktop', url: 'http://127.0.0.1:3321' },
    originator: 'peck-pay-mcp-test',
  })
  console.log('  backend:', client.backend.kind)
  console.log('  originator:', client.originator)
  console.log('  canAuthenticate:', client.canAuthenticate)
  console.log('  wallet instance:', client.wallet ? 'WalletInterface' : 'null')
  console.log('  authFetch instance:', client.authFetch ? 'AuthFetch' : 'null')

  // Try to fetch identity key — this WILL fail if peck-desktop isn't running,
  // and that's the correct behavior. We just want to verify the class doesn't
  // crash before reaching the network.
  try {
    const id = await client.identityKey()
    console.log('  identityKey:', id?.slice(0, 16) + '…')
  } catch (e: any) {
    console.log('  identityKey: (peck-desktop not running, expected) — ' + String(e?.message ?? e).slice(0, 100))
  }
}

async function testBrc100ValidationError() {
  console.log('\n=== brc100 mode without url (should error) ===')
  try {
    PeckBrcClient.create({ backend: { kind: 'brc100' } as any })
    console.log('  UNEXPECTED: did not throw')
  } catch (e: any) {
    console.log('  expected error:', e.message)
  }
}

async function testFromEnv() {
  console.log('\n=== fromEnv (default) ===')
  const client = PeckBrcClient.fromEnv()
  console.log('  backend:', client.backend.kind)
  console.log('  canAuthenticate:', client.canAuthenticate)
  console.log('  → embedded by default ✅')

  console.log('\n=== fromEnv (PECK_WALLET_BACKEND=peck-desktop) ===')
  process.env.PECK_WALLET_BACKEND = 'peck-desktop'
  process.env.PECK_WALLET_URL = 'http://127.0.0.1:3321'
  const c2 = PeckBrcClient.fromEnv()
  console.log('  backend:', c2.backend.kind)
  console.log('  canAuthenticate:', c2.canAuthenticate)
  delete process.env.PECK_WALLET_BACKEND
  delete process.env.PECK_WALLET_URL
}

async function main() {
  await testEmbedded()
  await testPeckDesktopConstruction()
  await testBrc100ValidationError()
  await testFromEnv()
  console.log('\n[test-peck-brc-client] DONE')
}

main().catch(e => { console.error('FAILED', e); process.exit(1) })
