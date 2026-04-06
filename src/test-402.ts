import express from 'express'
import { requirePayment, PaymentClient } from './x402.js'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runDemo() {
  console.log('='.repeat(60))
  console.log('  AP1C: HTTP 402 Payment Required Protocol Demo')
  console.log('='.repeat(60))

  // --- 1. Start Mock ARC Server (for testing SSE/polling) ---
  const mockArc = express()
  const MOCK_ARC_PORT = 3001
  const MOCK_ARC_URL = `http://localhost:${MOCK_ARC_PORT}`

  mockArc.get('/v1/tx/:txid/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    
    // Simulate ARC finding the transaction on the network
    const payload = JSON.stringify({ 
      txStatus: 'SEEN_ON_NETWORK', 
      txid: req.params.txid 
    })
    
    // Send after a small delay to simulate network latency
    setTimeout(() => {
      res.write(`data: ${payload}\n\n`)
    }, 100)
  })

  mockArc.get('/v1/tx/:txid', (req, res) => {
    res.json({
      txStatus: 'SEEN_ON_NETWORK',
      txid: req.params.txid
    })
  })

  const arcServer = mockArc.listen(MOCK_ARC_PORT, () => {
    console.log(`[Mock ARC] Listening on port ${MOCK_ARC_PORT}`)
  })

  // --- 2. Start Service Agent (requires 402 payment) ---
  const service = express()
  const SERVICE_PORT = 3000

  service.get('/api/compute', requirePayment({
    address: '1DemoAgentAddress123',
    amount: 50,
    brc103Identity: 'agent-service-alpha',
    arcUrl: MOCK_ARC_URL // Point to our mock
  }), (req, res) => {
    res.json({
      success: true,
      result: 'The answer is 42 (computed after payment)'
    })
  })

  const serviceServer = service.listen(SERVICE_PORT, () => {
    console.log(`[Service]  Listening on port ${SERVICE_PORT} (Requires 50 satoshis)`)
  })

  await sleep(500)
  console.log()

  // --- 3. Client Agent making request ---
  console.log('[Client]   Initiating request to /api/compute...')
  
  const client = new PaymentClient(async (address, amount) => {
    console.log(`[Client]   Constructing BSV payment of ${amount} to ${address}...`)
    await sleep(200) // Simulate TX signing
    const mockTxid = `mock-tx-${Date.now()}`
    console.log(`[Client]   Payment broadcasted! TXID: ${mockTxid}`)
    return mockTxid
  })

  try {
    // First request will hit 402, client auto-pays, retries and gets 200
    const res = await client.fetch(`http://localhost:${SERVICE_PORT}/api/compute`)
    const data = await res.json()
    console.log(`[Client]   Final Response Status: ${res.status}`)
    console.log(`[Client]   Final Response Body:`, data)
    
    console.log()
    console.log('[Client]   Making second request to same endpoint (should use cached payment)...')
    const res2 = await client.fetch(`http://localhost:${SERVICE_PORT}/api/compute`)
    const data2 = await res2.json()
    console.log(`[Client]   Second Response Status: ${res2.status}`)
    console.log(`[Client]   Second Response Body:`, data2)

  } catch (err) {
    console.error('Error during client fetch:', err)
  }

  // --- Cleanup ---
  console.log('\nShutting down servers...')
  arcServer.close()
  serviceServer.close()
}

runDemo().catch(console.error)
