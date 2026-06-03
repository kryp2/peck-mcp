/**
 * schema-builders.ts — pure Bitcoin Schema script builders.
 *
 * Extracted from peck-mcp-remote.ts so the byte layout can be unit-tested
 * without importing the server entry (which starts an HTTP listener on import).
 * The server wraps these with its module-level config (APP_NAME, NETWORK).
 */
import { Script, OP, PrivateKey } from '@bsv/sdk'
import { pushAcc, signAip, PROTO_MAP } from 'bitcoin-agent-wallet'

/**
 * MAP-only OP_RETURN write: `OP_FALSE OP_RETURN <MAP SET app … type … fields…>`
 * followed by an AIP signature over the accumulated data pushes.
 */
export function buildMapScript(
  type: string,
  fields: Record<string, string>,
  signingKey: PrivateKey,
  app: string,
  network: 'main' | 'test',
): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  const acc: number[] = []
  pushAcc(s, acc, PROTO_MAP); pushAcc(s, acc, 'SET')
  pushAcc(s, acc, 'app'); pushAcc(s, acc, app)
  pushAcc(s, acc, 'type'); pushAcc(s, acc, type)
  for (const [k, v] of Object.entries(fields)) { pushAcc(s, acc, k); pushAcc(s, acc, v) }
  signAip(s, acc, signingKey, network)
  return s
}
