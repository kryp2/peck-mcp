/**
 * Ladder DB — SQLite (via knex, already in deps) tracking pre-built UTXO
 * leaves and the setup transactions that created them.
 *
 * Schema:
 *   setup_txs:  (txid PK, raw_hex, network, created_at)  — caches the parent
 *               tx hex so the rifle can build inputs without WoC lookups
 *   leaves:     (txid, vout) PK, satoshis, owner_agent, used flag,
 *               used_at, used_in_txid                  — the ammunition pile
 *
 * Index: (owner_agent, used) so claim-next-leaf is O(log n).
 */
import knexFactory, { Knex } from 'knex'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface LeafRow {
  txid: string
  vout: number
  satoshis: number
  owner_agent: string
  used: number
  used_at: number | null
  used_in_txid: string | null
}

export interface SetupTxRow {
  txid: string
  raw_hex: string
  network: string
  created_at: number
}

export class LadderDB {
  private knex: Knex

  constructor(public readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.knex = knexFactory({
      client: 'sqlite3',
      connection: { filename: dbPath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },  // single writer to avoid sqlite lock contention
    })
  }

  async init(): Promise<void> {
    if (!(await this.knex.schema.hasTable('setup_txs'))) {
      await this.knex.schema.createTable('setup_txs', t => {
        t.string('txid').primary()
        t.text('raw_hex').notNullable()
        t.string('network').notNullable()
        t.bigInteger('created_at').notNullable()
      })
    }
    if (!(await this.knex.schema.hasTable('leaves'))) {
      await this.knex.schema.createTable('leaves', t => {
        t.string('txid').notNullable()
        t.integer('vout').notNullable()
        t.integer('satoshis').notNullable()
        t.string('owner_agent').notNullable()
        t.integer('used').notNullable().defaultTo(0)
        t.bigInteger('used_at').nullable()
        t.string('used_in_txid').nullable()
        t.primary(['txid', 'vout'])
        t.index(['owner_agent', 'used'], 'idx_owner_used')
      })
    }
  }

  async insertSetupTx(row: SetupTxRow): Promise<void> {
    await this.knex('setup_txs').insert(row).onConflict('txid').ignore()
  }

  async getSetupTxHex(txid: string): Promise<string | null> {
    const r = await this.knex('setup_txs').select('raw_hex').where({ txid }).first()
    return r?.raw_hex ?? null
  }

  async insertLeaves(rows: Omit<LeafRow, 'used' | 'used_at' | 'used_in_txid'>[]): Promise<void> {
    if (rows.length === 0) return
    // chunk to avoid the sqlite parameter limit (~999 vars per statement)
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.knex('leaves')
        .insert(rows.slice(i, i + CHUNK).map(r => ({ ...r, used: 0 })))
        .onConflict(['txid', 'vout'])
        .ignore()
    }
  }

  /**
   * Atomically claim the next unused leaf for an agent. Marks it as used
   * BEFORE the rifle even builds the tx, so concurrent rifles cannot pick
   * the same leaf. If broadcast later fails, caller must releaseLeaf().
   */
  async claimLeaf(agent: string): Promise<LeafRow | null> {
    return await this.knex.transaction(async trx => {
      const leaf = await trx('leaves')
        .where({ owner_agent: agent, used: 0 })
        .orderBy(['txid', 'vout'])
        .first()
      if (!leaf) return null
      const updated = await trx('leaves')
        .where({ txid: leaf.txid, vout: leaf.vout, used: 0 })
        .update({ used: 1, used_at: Date.now() })
      if (updated !== 1) return null  // race lost — caller retries
      return leaf as LeafRow
    })
  }

  async markFired(txid: string, vout: number, firedTxid: string): Promise<void> {
    await this.knex('leaves')
      .where({ txid, vout })
      .update({ used_in_txid: firedTxid })
  }

  async releaseLeaf(txid: string, vout: number): Promise<void> {
    await this.knex('leaves')
      .where({ txid, vout })
      .update({ used: 0, used_at: null, used_in_txid: null })
  }

  async stats(agent?: string): Promise<{ total: number; used: number; remaining: number }> {
    const q = this.knex('leaves')
    if (agent) q.where({ owner_agent: agent })
    const all = await q.clone().count<{ n: number }>({ n: '*' }).first()
    const used = await q.clone().where({ used: 1 }).count<{ n: number }>({ n: '*' }).first()
    const total = Number(all?.n ?? 0)
    const usedN = Number(used?.n ?? 0)
    return { total, used: usedN, remaining: total - usedN }
  }

  async close(): Promise<void> {
    await this.knex.destroy()
  }
}
