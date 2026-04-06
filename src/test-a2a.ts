import { PrivateKey } from '@bsv/sdk'
import { A2AProtocol, TaskManager } from './a2a-protocol.js'
import { AgentCardManager, AgentCard } from './agent-card.js'

async function runTest() {
  const pk1 = PrivateKey.fromRandom()
  const pk2 = PrivateKey.fromRandom()

  // Agent 1: The Client
  const clientProtocol = new A2AProtocol(pk1)
  
  // Agent 2: The Translator
  const translatorCard: AgentCard = {
    name: "translate-agent",
    capabilities: ["translate", "detect-language"],
    pricing: { "translate": 500 },
    endpoint: "https://agent.example.com/a2a",
    identity: "txid_123456789",
    protocols: ["a2a", "mcp", "http402"]
  }
  const translatorCardManager = new AgentCardManager(translatorCard)
  const translatorProtocol = new A2AProtocol(pk2)
  const taskManager = new TaskManager()

  console.log("=== A2A Protocol Test: Negotiation & Delegation ===\n")

  // 1. Discover
  console.log("[Client] Sending agent/discover...")
  const discoverReq = clientProtocol.createRequest('agent/discover', {})
  console.log("Discover Request:", JSON.stringify(discoverReq, null, 2))

  const discoverRes = translatorProtocol.createResponse(discoverReq.id, translatorCardManager.getCard())
  console.log("Discover Response:", JSON.stringify(discoverRes, null, 2))

  const isDiscoverValid = clientProtocol.verifySignature(
    { id: discoverRes.id, result: discoverRes.result },
    discoverRes.signature!,
    discoverRes.pubkey!
  )
  console.log(`[Client] Discover Response Signature Valid: ${isDiscoverValid}`)

  // 2. Negotiate Price for translation
  console.log("\n[Client] Sending agent/negotiate...")
  const negotiateReq = clientProtocol.createRequest('agent/negotiate', {
    task: "translate",
    text: "Hello world",
    offer: 400
  })
  
  // Translator evaluates offer (pricing is 500, offer is 400 -> counter-offer)
  const negotiateRes = translatorProtocol.createResponse(negotiateReq.id, {
    status: "counter-offer",
    price: 450,
    currency: "sats"
  })
  console.log("Negotiate Response:", JSON.stringify(negotiateRes, null, 2))

  // 3. Delegate task
  console.log("\n[Client] Sending agent/delegate at agreed price 450 sats...")
  const taskId = "task_999"
  const delegateReq = clientProtocol.createRequest('agent/delegate', {
    taskId,
    task: "translate",
    params: { text: "Hello world", targetLang: "es" },
    paymentTx: "tx_hex_with_450_sats"
  })

  // Translator accepts and registers task
  taskManager.submitTask(taskId)
  const delegateRes = translatorProtocol.createResponse(delegateReq.id, {
    taskId,
    status: "accepted"
  })
  console.log("Delegate Response:", JSON.stringify(delegateRes, null, 2))

  // 4. Status update (SSE mock)
  console.log("\n[Translator] Streaming artifacts via SSE...")
  taskManager.updateTask(taskId, 'working')
  const statusReq = translatorProtocol.createRequest('agent/status', {
    taskId,
    state: "working",
    progress: 50,
    artifact: "Hola "
  })
  console.log("Status Update (SSE Chunk):", JSON.stringify(statusReq, null, 2))

  // 5. Complete
  console.log("\n[Translator] Task complete.")
  const completeReq = translatorProtocol.createRequest('agent/complete', {
    taskId,
    state: "completed",
    result: "Hola mundo"
  })
  taskManager.updateTask(taskId, 'completed')
  console.log("Complete Request:", JSON.stringify(completeReq, null, 2))
}

runTest().catch(console.error)
