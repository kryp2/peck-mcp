/**
 * EVM-as-a-Service compute agent.
 *
 * Receives EVM bytecode + calldata, executes off-chain, returns
 * result + execution proof. The proof can be anchored to BSV by the
 * caller (or by this agent, depending on flow).
 *
 * Headline pitch: "Outsource Ethereum bytecode execution to a BSV-
 * anchored worker for 100 sat (~$0.0001) instead of paying $0.50–$5
 * in real Ethereum gas. The execution_hash is anchored on BSV; any
 * disputing party can re-run locally and verify."
 */
import { BrcServiceAgent } from '../brc-service-agent.js'
import { executeEvm } from '../evm-executor.js'

const agent = new BrcServiceAgent({
  name: 'evm-compute-agent',
  walletName: 'evm-compute',
  description: 'Off-chain Ethereum Virtual Machine execution, anchored on BSV',
  pricePerCall: 100,
  capabilities: ['execute', 'execute-with-anchor'],
  port: 3010,
})

agent.handle('execute', async (req) => {
  if (!req.bytecode) throw new Error('bytecode (hex) required')
  const receipt = await executeEvm({
    bytecodeHex: req.bytecode,
    calldataHex: req.calldata,
    gasLimit: req.gasLimit ? BigInt(req.gasLimit) : undefined,
  })
  return {
    ok: receipt.exception_error === null,
    receipt,
    note: 'Re-run any worker with the same bytecode+calldata to reproduce the execution_hash.',
  }
})

// 'execute-with-anchor' is identical for now; the BSV anchoring is wired
// in the test-evm-service.ts driver where we have access to a UTXOManager.
// In a production flow this agent would have its own wallet and self-anchor.
agent.handle('execute-with-anchor', async (req) => {
  if (!req.bytecode) throw new Error('bytecode (hex) required')
  const receipt = await executeEvm({
    bytecodeHex: req.bytecode,
    calldataHex: req.calldata,
    gasLimit: req.gasLimit ? BigInt(req.gasLimit) : undefined,
  })
  return {
    ok: receipt.exception_error === null,
    receipt,
    anchor_pending: true,
    note: 'BSV anchoring is performed by the orchestrator after this response returns.',
  }
})

agent.start()
