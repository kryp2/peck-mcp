import { ReputationScorer, ReputationAPI, ContractEvent } from './reputation.js';
import { PrivateKey } from '@bsv/sdk';

async function test() {
  // Test scenario for AP3D: Agentic Reputation Scorer
  console.log('--- Agentic Reputation Scorer Test ---');
  let anchoredSnapshots = 0;
  
  const anchorKey = PrivateKey.fromRandom();
  const scorer = new ReputationScorer(anchorKey, (snapshot) => {
    anchoredSnapshots++;
    console.log(`[Anchor] Snapshot triggered. Total agents in snapshot: ${Object.keys(snapshot).length}`);
  });

  const api = new ReputationAPI(scorer, 3001);
  api.start();

  const agent1 = 'agent-123';
  const agent2 = 'agent-456';

  console.log('\nSimulating 10 contract events...');

  // Simulate 10 events
  const events: ContractEvent[] = [
    { agentId: agent1, type: 'completion', response_ms: 120, earned_satoshis: 100 },
    { agentId: agent1, type: 'completion', response_ms: 150, earned_satoshis: 100 },
    { agentId: agent2, type: 'completion', response_ms: 800, earned_satoshis: 200 },
    { agentId: agent1, type: 'completion', response_ms: 130, earned_satoshis: 100 },
    { agentId: agent2, type: 'failure' },
    { agentId: agent1, type: 'completion', response_ms: 110, earned_satoshis: 100 },
    { agentId: agent1, type: 'completion', response_ms: 140, earned_satoshis: 100 },
    { agentId: agent2, type: 'dispute' },
    { agentId: agent1, type: 'completion', response_ms: 100, earned_satoshis: 100 },
    { agentId: agent2, type: 'completion', response_ms: 1100, earned_satoshis: 200 }
  ];

  for (const event of events) {
    // We simulate hex OP_RETURN parsing
    const simulatedOpReturn = JSON.stringify({ ap_event: event });
    const hexData = Buffer.from(simulatedOpReturn, 'utf8').toString('hex');
    
    const parsedEvent = scorer.parseOpReturnEvent(hexData);
    if (parsedEvent) {
      await scorer.processEvent(parsedEvent);
    }
  }

  // Check scores locally
  const score1 = scorer.getTrustScore(agent1);
  const score2 = scorer.getTrustScore(agent2);

  console.log('\nResults locally:');
  console.log(`Agent 1 (Good): Trust Score = ${score1.score}`);
  console.log(score1.breakdown);
  console.log(`Agent 2 (Bad): Trust Score = ${score2.score}`);
  console.log(score2.breakdown);

  // Assertions
  let passed = true;

  if (score1.score > score2.score) {
    console.log('✅ Agent 1 has a higher score than Agent 2');
  } else {
    console.log('❌ Agent 1 score should be higher');
    passed = false;
  }

  if (score1.breakdown.tasks_completed === 6) {
    console.log('✅ Agent 1 completed tasks correctly tracked');
  } else {
    console.log('❌ Agent 1 completed tasks incorrect');
    passed = false;
  }

  if (score2.breakdown.dispute_rate > 0) {
    console.log('✅ Agent 2 dispute rate correctly tracked');
  } else {
    console.log('❌ Agent 2 dispute rate incorrect');
    passed = false;
  }

  // Test the API
  console.log('\nTesting Query API...');
  
  // 1. Unpaid request
  try {
    const unpaidRes = await fetch(`http://localhost:3001/reputation/${agent1}`);
    if (unpaidRes.status === 402) {
      console.log('✅ API correctly rejects unpaid queries');
    } else {
      console.log('❌ API allowed unpaid query');
      passed = false;
    }
  } catch (e) {
    console.log('❌ API Unpaid request failed completely:', e);
    passed = false;
  }

  // 2. Paid request
  try {
    const paidRes = await fetch(`http://localhost:3001/reputation/${agent1}`, {
      headers: { 'X-Payment-Tx': 'tx12345' }
    });
    if (paidRes.status === 200) {
      const data = await paidRes.json();
      console.log('✅ API returned data for paid query:', data.score);
    } else {
      console.log('❌ API failed paid query');
      passed = false;
    }
  } catch (e) {
    console.log('❌ API Paid request failed completely:', e);
    passed = false;
  }

  // 3. Batch POST
  try {
    const batchRes = await fetch(`http://localhost:3001/reputation/batch`, {
      method: 'POST',
      headers: { 'X-Payment-Tx': 'tx67890', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentIds: [agent1, agent2] })
    });
    if (batchRes.status === 200) {
      const data = await batchRes.json();
      console.log('✅ API Batch returned data:', data.results.length, 'agents');
    } else {
      console.log('❌ API Batch failed');
      passed = false;
    }
  } catch (e) {
    console.log('❌ API Batch request failed completely:', e);
    passed = false;
  }

  // Test on-chain anchoring condition
  console.log('\nTesting on-chain anchoring...');
  for(let i=0; i<90; i++) {
    await scorer.processEvent({ agentId: agent1, type: 'completion' });
  }
  if (anchoredSnapshots === 1) {
    console.log('✅ Anchoring triggered correctly after 100 events');
  } else {
    console.log('❌ Anchoring failed to trigger');
    passed = false;
  }

  // Teardown
  await api.stop();
  console.log('\n--- Test Complete ---');

  if (!passed) {
    process.exit(1);
  }
}

test().catch((e) => {
  console.error(e);
  process.exit(1);
});
