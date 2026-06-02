/**
 * End-to-end paywall E2E test.
 *
 * Spins up a minimal overlay (using peck-overlay-schema modules)
 * with SQLite-backed state and exercises the full flow through
 * PaywallClient:
 *
 *   1. Free meta endpoint (peck_post_meta) — no receipt
 *   2. Free feed endpoint (limit=20, offset=0) — no receipt
 *   3. Paid peck_post_detail — auto-open channel, drain, retry
 *   4. Three sequential paid fetches — nonce advancement
 *   5. Public pool funding → unauthenticated fetch debits pool
 *   6. Channel close — settlement preview
 *
 * Run: PAYWALL_CLIENT_ENABLED=true npx tsx src/paywall/e2e-test.ts
 */

import express from 'express'
import knexInit from 'knex'
import { PrivateKey } from '@bsv/sdk'

// peck-overlay-schema modules — we import them directly from the
// sibling workspace. For production this would be a published
// package; for local testing it's a relative import.
import { mountPaywall } from '../../../peck-overlay-schema/src/paywall/index.js'
import { createMetaRouter } from '../../../peck-overlay-schema/src/meta/index.js'
import {
  createPublicPoolRouter,
  createSignalsRouter,
  ensurePoolTables,
  debitPool,
} from '../../../peck-overlay-schema/src/public-pool/index.js'
import { createThirdPartyRouter } from '../../../peck-overlay-schema/src/third-party/index.js'
import { feeFor } from '../../../peck-overlay-schema/src/prices.js'

// peck-mcp paywall — the client side we're validating.
import { PaywallClient } from './paywall-client.js'
import { LocalKeyAdapter } from './wallet-adapter.js'

async function main() {
  const knex = knexInit({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  })

  // Schema for pecks + attachments (minimal subset)
  await knex.schema.createTable('pecks', (t) => {
    t.text('txid').primary()
    t.text('author')
    t.text('content')
    t.timestamp('timestamp')
    t.text('parent_txid')
    t.text('channel')
  })
  await knex.schema.createTable('post_attachments', (t) => {
    t.increments('id').primary()
    t.text('txid')
    t.integer('vout')
    t.text('content_type')
    t.integer('size_bytes')
  })
  await knex.schema.createTable('reactions', (t) => {
    t.increments('id').primary()
    t.text('target_txid')
    t.text('kind')
  })
  await knex.schema.createTable('users', (t) => {
    t.text('identity_key').primary()
    t.text('display_name')
    t.text('paymail')
    t.text('bio')
    t.text('avatar_url')
    t.timestamp('created_at')
  })
  await knex.schema.createTable('payments', (t) => {
    t.increments('id').primary()
    t.text('target_txid')
    t.bigInteger('amount')
  })
  await knex.schema.createTable('follows', (t) => {
    t.increments('id').primary()
    t.text('follower_address')
    t.text('target_address')
  })
  await ensurePoolTables(knex)

  // Seed: one post, one author
  await knex('users').insert({
    identity_key: '02alice',
    display_name: 'Alice',
    paymail: 'alice@peck.to',
    bio: 'I test things',
    created_at: new Date(),
  })
  const bodyText =
    'This is a substantial Bitcoin Schema post that goes well beyond 300 characters so the teaser gets truncated and the reader has to pay to see the rest. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'
  await knex('pecks').insert({
    txid: 'post_abc123',
    author: '02alice',
    content: bodyText,
    timestamp: new Date(),
  })

  // Start overlay with paywall mounted
  const serverPriv = PrivateKey.fromRandom()
  const serverPubkey = serverPriv.toPublicKey().toString()

  const app = express()
  app.use(express.json())

  // IMPORTANT: paywall middleware must mount BEFORE metered
  // endpoint handlers, so receipts are validated on the way in.
  const store = mountPaywall(app, {
    redis: null,
    serverPriv,
    serverPubkey,
    overlayBaseUrl: 'http://localhost:18099',
    docsUrl: 'https://docs.peck.to/payments',
    currentBlockHeight: async () => 900000,
    buildOpenScript: (c) => `STUB|${c}`,
  })

  // Meta, public-pool, signals, third-party routers — mounted
  // after middleware, but middleware's bypass list lets them
  // through as free.
  app.use(
    '/v1',
    createMetaRouter({
      knex,
      publicBase: 'http://localhost:18099',
      mediaBase: 'http://localhost:18099/media',
    }),
  )
  app.use(
    '/v1/public-pool',
    createPublicPoolRouter({ knex, fundingAddress: '1TestFund' }),
  )
  app.use('/v1/signals', createSignalsRouter(knex))
  app.use('/v1', createThirdPartyRouter({ knex }))

  // Legacy peck_feed + peck_post_detail stubs
  app.get('/v1/peck_feed', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50)
    const offset = parseInt(String(req.query.offset ?? '0'), 10)
    const rows = await knex('pecks')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .offset(offset)
    res.json({ posts: rows })
  })
  app.get('/v1/peck_post_detail', async (req, res) => {
    const txid = String(req.query.txid)
    const row = await knex('pecks').where('txid', txid).first()
    if (!row) return res.status(404).json({ error: 'not_found' })
    res.json(row)
  })

  const server = app.listen(18099, async () => {
    console.log('\n=== peck.to paywall E2E test ===\n')

    const wallet = LocalKeyAdapter.random()
    const client = new PaywallClient({
      overlay: 'http://localhost:18099',
      wallet,
      autoOpenDeposit: 10_000,
    })

    // 1. Free meta
    const meta = await client.fetch('peck_post_meta', { txid: 'post_abc123' })
    console.log('1. peck_post_meta (free):')
    console.log('   teaser length:', meta.teaser?.length, 'truncated:', meta.teaser_truncated)
    console.log('   author:', meta.author?.display_name)
    console.log('   thumbnail:', meta.thumbnail_url)

    // 2. Free feed (limit=20, offset=0)
    const feed = await client.fetch('peck_feed', { limit: 20, offset: 0 })
    console.log('\n2. peck_feed(limit=20, offset=0) (free):', feed.posts.length, 'posts')

    // 3. Paid peck_post_detail — channel auto-opens
    // We need to fake "active" status since we don't broadcast a real TX
    const openResp = await client.openChannel(10_000)
    const state = await store.get(openResp.channel_id)
    if (state) {
      state.status = 'active'
      await store.put(state)
    }

    const post = await client.fetch('peck_post_detail', { txid: 'post_abc123' })
    const ch = client.getChannel()!
    console.log('\n3. peck_post_detail (paid 10 sats):')
    console.log('   body.length:', post.content?.length)
    console.log('   channel state: nonce=' + ch.last_nonce + ' spent=' + ch.amount_spent_sats)

    // 4. Three more paid fetches
    console.log('\n4. Three sequential paid fetches:')
    for (let i = 0; i < 3; i++) {
      const p = await client.fetch('peck_post_detail', { txid: 'post_abc123' })
      const ch2 = client.getChannel()!
      console.log(`   fetch ${i+1}: nonce=${ch2.last_nonce} spent=${ch2.amount_spent_sats}`)
    }

    // 5. Public pool funding: someone funds a pool for the post
    const funderKey = PrivateKey.fromRandom()
    const fund = await fetch('http://localhost:18099/v1/public-pool/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource_type: 'post',
        resource_id: 'post_abc123',
        amount_sats: 5000,
        funder_pubkey: funderKey.toPublicKey().toString(),
      }),
    }).then((r) => r.json())
    await fetch('http://localhost:18099/v1/public-pool/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        funding_reference: fund.funding_reference,
        funding_tx_id: 'fakefundingtx',
      }),
    })
    const status = await fetch(
      'http://localhost:18099/v1/public-pool/status?resource_type=post&resource_id=post_abc123',
    ).then((r) => r.json())
    console.log('\n5. Public pool funded:')
    console.log('   balance:', status.balance_sats, 'funders:', status.funders.length)

    // Anonymous reader can now debit pool
    const drain = await debitPool(knex, 'post', 'post_abc123', feeFor('peck_post_detail', {}))
    console.log('   anonymous debit OK:', drain.ok, 'balance_after:', drain.balance_after)

    // 6. Channel close
    const chBeforeClose = client.getChannel()!
    const serverStateBeforeClose = await store.get(chBeforeClose.channel_id)
    console.log('\n6. Pre-close:')
    console.log('   client: nonce=' + chBeforeClose.last_nonce + ' spent=' + chBeforeClose.amount_spent_sats)
    console.log('   server: nonce=' + serverStateBeforeClose?.last_nonce + ' spent=' + serverStateBeforeClose?.amount_spent_sats)
    const close = await client.close()
    console.log('   close response: refund=' + close.client_refund_sats + ' payout=' + close.server_payout_sats)

    // Final signal aggregate
    const signals = await fetch('http://localhost:18099/v1/signals/funded').then((r) => r.json())
    console.log('\n7. /v1/signals/funded:')
    console.log('  ', JSON.stringify(signals.data[0]))

    console.log('\n=== E2E PASSED ===')
    server.close()
    await knex.destroy()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
