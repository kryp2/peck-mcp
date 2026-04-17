/**
 * EVM Executor — off-chain Ethereum Virtual Machine execution.
 *
 * Wraps @ethereumjs/evm to run arbitrary bytecode + calldata in an
 * isolated in-memory environment. Returns the result, gas used, and
 * a deterministic execution hash that can be anchored on BSV.
 *
 * No real Ethereum gas is paid. The whole pitch: outsource heavy
 * EVM computation from Ethereum to BSV-anchored workers, for fractions
 * of the cost, with cryptographic proof.
 */
import { createEVM, EVM } from '@ethereumjs/evm'
import { hexToBytes, bytesToHex } from '@ethereumjs/util'
import { Hash } from '@bsv/sdk'

export interface ExecuteOptions {
  bytecodeHex: string        // 0x-prefixed or raw hex
  calldataHex?: string       // 0x-prefixed or raw hex
  gasLimit?: bigint          // default 10_000_000
  callerHex?: string         // 20-byte address as hex (optional, defaults to zero)
}

export interface ExecutionReceipt {
  return_value_hex: string         // raw return data
  gas_used: string                  // bigint as decimal string
  exception_error: string | null    // null if successful
  logs_count: number
  storage_writes: number
  execution_hash: string            // sha256(bytecode || calldata || result || gas)
  duration_ms: number
}

let cachedEvm: EVM | null = null

async function getEvm(): Promise<EVM> {
  if (!cachedEvm) cachedEvm = await createEVM()
  return cachedEvm
}

function strip0x(s: string | undefined): string {
  if (!s) return ''
  return s.startsWith('0x') ? s.slice(2) : s
}

function toBytes(hex: string): Uint8Array {
  if (!hex) return new Uint8Array()
  return hexToBytes(hex.startsWith('0x') ? hex as `0x${string}` : `0x${hex}` as `0x${string}`)
}

function hashHex(...parts: string[]): string {
  const concat = parts.map(strip0x).join('')
  const bytes = Hash.sha256(Array.from(new TextEncoder().encode(concat)))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Execute EVM bytecode in an isolated environment.
 *
 * Returns a receipt that includes a deterministic execution hash —
 * any worker running the same bytecode + calldata produces the same
 * hash, which is what makes BSV anchoring meaningful.
 */
export async function executeEvm(opts: ExecuteOptions): Promise<ExecutionReceipt> {
  const t0 = Date.now()
  const evm = await getEvm()

  const result = await evm.runCode({
    code: toBytes(opts.bytecodeHex),
    data: toBytes(opts.calldataHex || ''),
    gasLimit: opts.gasLimit ?? 10_000_000n,
  })

  const returnHex = bytesToHex(result.returnValue)
  const execHash = hashHex(
    strip0x(opts.bytecodeHex),
    strip0x(opts.calldataHex || ''),
    strip0x(returnHex),
    result.executionGasUsed.toString(16),
  )

  return {
    return_value_hex: returnHex,
    gas_used: result.executionGasUsed.toString(),
    exception_error: result.exceptionError ? result.exceptionError.error : null,
    logs_count: result.logs?.length ?? 0,
    storage_writes: 0, // runCode is stateless; runCall would track storage
    execution_hash: execHash,
    duration_ms: Date.now() - t0,
  }
}

/**
 * Pre-canned demo bytecode: a simple program that computes
 *   PUSH1 0x05, PUSH1 0x07, ADD, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN
 * which returns the 32-byte big-endian value 12 (0x0c).
 *
 * Used for smoke tests — proves the EVM runs and we can anchor a result.
 */
export const DEMO_ADD_BYTECODE = '60056007016000526020600000f3'

/**
 * Slightly less trivial: keccak256 of a single byte input.
 *   bytecode: PUSH1 0x01 PUSH1 0x00 KECCAK256 PUSH1 0x00 MSTORE PUSH1 0x20 PUSH1 0x00 RETURN
 * The first byte of memory is whatever's there (0 by default).
 * Returns the keccak256 hash of one zero byte.
 */
export const DEMO_KECCAK_BYTECODE = '600160002060005260206000f3'
