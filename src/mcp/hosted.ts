/**
 * Hosted (read-only) mode for peck-mcp.
 *
 * The npm package runs locally over stdio with a keychain-resident BRC-100
 * identity, and that is the only place writes happen. The same code also
 * serves https://mcp.peck.to over StreamableHTTP so any MCP client can read
 * the Bitcoin Schema archive with one config line and no install. A shared
 * server has no business holding anyone's key, so in HTTP mode the wallet is
 * never loaded and only the read tools are listed. Set PECK_MCP_ALLOW_WRITES=1
 * to run HTTP with the full tool set on your own machine.
 */

/** Tools that only read from the overlay / headers service. No wallet, no key. */
export const HOSTED_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'peck_feed',
  'peck_recent',
  'peck_trending',
  'peck_search',
  'peck_thread',
  'peck_post_detail',
  'peck_user_posts',
  'peck_profile',
  'peck_follows',
  'peck_friends',
  'peck_messages',
  'peck_payments',
  'peck_functions',
  'peck_stats',
  'peck_apps',
  'peck_chain_tip',
  'peck_block_at_height',
])

export const HOSTED_INSTALL_HINT =
  'This hosted server is read-only and holds no keys. For writes install locally: ' +
  'npm install -g peck-mcp && claude mcp add peck peck-mcp (identity lives in your OS keychain).'

/** HTTP transport is read-only unless the operator opts into writes explicitly. */
export function isReadOnlyMode(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  const stdio = env.MCP_TRANSPORT === 'stdio' || argv.includes('--stdio')
  if (stdio) return false
  return env.PECK_MCP_ALLOW_WRITES !== '1'
}

export function filterHostedTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(t => HOSTED_READ_ONLY_TOOLS.has(t.name))
}

/** Returns an error payload (as JSON text) when a call is not allowed in hosted mode, else null. */
export function hostedRefusal(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!HOSTED_READ_ONLY_TOOLS.has(name)) {
    return JSON.stringify({
      error: `${name} is not available on the hosted server`,
      hint: HOSTED_INSTALL_HINT,
    })
  }
  if (name === 'peck_messages' && args && args.signing_key) {
    return JSON.stringify({
      error: 'never send a signing key to a hosted server',
      hint: 'Run peck-mcp locally to decrypt PECK1 messages; the hosted server returns ciphertext only.',
    })
  }
  return null
}
