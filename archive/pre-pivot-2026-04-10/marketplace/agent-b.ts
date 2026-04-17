/**
 * Agent B ("Eva") — The Analyst/Consumer
 *
 * Discovers Agent A via MessageBox/BRC-103, negotiates prices,
 * and buys data/resources via micropayments.
 *
 * TODO: This is a skeleton — fill in during hackathon
 */

import { PrivateKey } from '@bsv/sdk'
import { AgentIdentity } from './identity.js'

interface AgentConfig {
  name: string
  privateKey: PrivateKey
  peerPublicKey?: string
  arcEndpoint: string
  network: 'testnet' | 'mainnet'
  identity?: AgentIdentity
}

class AgentB {
  private config: AgentConfig
  private txCount = 0
  private budget = 0 // satoshis available

  constructor(config: AgentConfig) {
    this.config = config
  }

  /**
   * Discovery — find Agent A on the network
   * Uses MessageBox + BRC-103 for mutual authentication
   */
  async discoverPeers(): Promise<void> {
    // TODO: Use MessageBox SHIP protocol to find Agent A
    // 1. Init MessageBoxClient with wallet
    // 2. Listen on 'negotiations' message box
    // 3. Authenticate via BRC-103 challenge/response
    console.log(`[${this.config.name}] Discovering peers...`)
  }

  /**
   * Strategy layer — periodic LLM evaluation
   */
  async evaluateMarket(): Promise<void> {
    // TODO: LLM analyzes what data to buy, at what price
    console.log(`[${this.config.name}] Market evaluation — txCount: ${this.txCount}, budget: ${this.budget} sat`)
  }

  /**
   * Execution layer — buy data from Agent A
   */
  async executePurchase(): Promise<void> {
    // TODO: Build micropayment TX to Agent A
    // 1. Check Agent A's current price
    // 2. Build TX: payment + OP_RETURN with data request
    // 3. Sign and broadcast
    // 4. Listen for Agent A's data delivery
    this.txCount++
  }

  async run(): Promise<void> {
    console.log(`[${this.config.name}] Starting on ${this.config.network}`)
    console.log(`[${this.config.name}] Address: ${this.config.privateKey.toAddress()}`)

    await this.discoverPeers()

    const TX_INTERVAL = 57
    const STRATEGY_INTERVAL = 5 * 60 * 1000
    let lastStrategy = 0
    const startTime = Date.now()

    setInterval(async () => {
      const now = Date.now()

      if (now - lastStrategy > STRATEGY_INTERVAL) {
        await this.evaluateMarket()
        lastStrategy = now
      }

      await this.executePurchase()

      if (this.txCount % 1000 === 0) {
        const tps = this.txCount / ((now - startTime) / 1000)
        console.log(`[${this.config.name}] TX #${this.txCount} | ${tps.toFixed(1)} TPS`)
      }
    }, TX_INTERVAL)
  }
}

const config: AgentConfig = {
  name: 'Eva',
  privateKey: PrivateKey.fromRandom(),
  arcEndpoint: 'https://arc.gorillapool.io',
  network: 'testnet',
}

const agent = new AgentB(config)
agent.run().catch(console.error)
