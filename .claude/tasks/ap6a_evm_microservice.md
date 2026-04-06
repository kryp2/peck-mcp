---
priority: 6
complexity: high
model: sonnet
depends_on: [ap3a_arcade_integration, ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-evm-service.ts"
---

# AP6A: Off-Chain EVM Execution Microservice

## Mål
"EVM-as-a-Service" — AI-agenter sender EVM bytecode + calldata,
off-chain worker eksekverer det, og anchorer resultat til BSV.
Radically expands TAM beyond BSV developer ecosystem.

## Kontekst fra rapport
"By offering EVM-as-a-Service, agents residing on high-value chains 
like Ethereum can outsource heavy computation to the BSV-backed 
marketplace at magnitudes lower cost. Only the cryptographic proof 
of the outcome is bridged back."

## Oppgaver

### 1. EVM execution engine (ethereumjs)
- Bruk @ethereumjs/evm for off-chain EVM execution
- Motta: bytecode, calldata, pre-state
- Returner: execution result, state diff, gas used
- InMemoryDB for isolert state per request

### 2. BSV state-chain anchoring
- State of EVM contract = lineage of BSV UTXOs
- Kun Merkle root av state lagres on-chain (O(log N))
- OP_RETURN: { contract_hash, state_root, execution_proof }
- Ny UTXO per state-oppdatering → state-chain

### 3. ServiceAgent wrapper
- Registrer som mikrotjeneste: "evm-compute"
- Pris: 100 satoshis per execution (~$0.005)
- Input: { bytecode_hex, calldata_hex, value_wei }
- Output: { result_hex, gas_used, state_diff }

### 4. Demo: ERC-20 off-chain
- Deploy enkel ERC-20 kontrakt off-chain
- Kjør transfer mellom to agenter
- State anchored i BSV — verifiserbar

### 5. Test
- Execute simple contract, verify state on BSV

## Filer
- `src/evm-executor.ts` — nytt
- `src/evm-state-chain.ts` — nytt
- `src/services/evm-compute-agent.ts` — nytt
- `src/test-evm-service.ts` — nytt
