import { describe, it, expect } from 'vitest'
import { HOSTED_READ_ONLY_TOOLS, filterHostedTools, hostedRefusal, isReadOnlyMode } from './hosted.js'

describe('isReadOnlyMode', () => {
  it('stdio (the npm install path) is never read-only', () => {
    expect(isReadOnlyMode({ MCP_TRANSPORT: 'stdio' }, [])).toBe(false)
    expect(isReadOnlyMode({}, ['node', 'x', '--stdio'])).toBe(false)
  })
  it('HTTP is read-only by default', () => {
    expect(isReadOnlyMode({}, [])).toBe(true)
    expect(isReadOnlyMode({ PORT: '8080' }, [])).toBe(true)
  })
  it('HTTP writes need an explicit opt-in', () => {
    expect(isReadOnlyMode({ PECK_MCP_ALLOW_WRITES: '1' }, [])).toBe(false)
    expect(isReadOnlyMode({ PECK_MCP_ALLOW_WRITES: 'yes' }, [])).toBe(true)
  })
})

describe('HOSTED_READ_ONLY_TOOLS', () => {
  it('contains no tool that broadcasts, spends, spawns or touches the keychain', () => {
    const forbidden = /_tx$|register|spawn|send_|request_|set_identity|identity_info|fleet_|function_call|function_check|balance/
    for (const name of HOSTED_READ_ONLY_TOOLS) expect(name).not.toMatch(forbidden)
  })
  it('is the documented read set', () => {
    expect([...HOSTED_READ_ONLY_TOOLS].sort()).toEqual([
      'peck_apps', 'peck_block_at_height', 'peck_chain_tip', 'peck_feed', 'peck_follows',
      'peck_friends', 'peck_functions', 'peck_messages', 'peck_payments', 'peck_post_detail',
      'peck_profile', 'peck_recent', 'peck_search', 'peck_stats', 'peck_thread',
      'peck_trending', 'peck_user_posts',
    ])
  })
})

describe('filterHostedTools', () => {
  it('keeps only read tools and preserves order', () => {
    const tools = [{ name: 'peck_post_tx' }, { name: 'peck_feed' }, { name: 'peck_fleet_spawn' }, { name: 'peck_chain_tip' }]
    expect(filterHostedTools(tools).map(t => t.name)).toEqual(['peck_feed', 'peck_chain_tip'])
  })
})

describe('hostedRefusal', () => {
  it('allows read tools', () => {
    expect(hostedRefusal('peck_feed', { limit: 5 })).toBeNull()
  })
  it('refuses write tools with an install hint', () => {
    const r = JSON.parse(hostedRefusal('peck_post_tx', {})!)
    expect(r.error).toContain('peck_post_tx')
    expect(r.hint).toContain('npm install -g peck-mcp')
  })
  it('refuses a signing key on the hosted messages tool', () => {
    expect(hostedRefusal('peck_messages', {})).toBeNull()
    const r = JSON.parse(hostedRefusal('peck_messages', { signing_key: 'aa' })!)
    expect(r.error).toMatch(/never send a signing key/)
  })
})
