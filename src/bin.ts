#!/usr/bin/env node
/**
 * peck-mcp CLI entry. Starts the MCP server in stdio transport so MCP
 * clients (Claude Desktop, Claude Code, Cursor, …) can spawn it as a
 * subprocess and talk to it over stdin/stdout.
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "peck": { "command": "peck-mcp" }
 *     }
 *   }
 *
 * Claude Code:
 *   claude mcp add peck peck-mcp
 *
 * Wallet identity is loaded from the OS keychain (libsecret / Keychain /
 * Credential Manager) via bitcoin-agent-wallet. Legacy ~/.peck/identity.json
 * auto-migrates on first run.
 */
process.env.MCP_TRANSPORT = 'stdio'
await import('./mcp/peck-mcp-remote.js')
