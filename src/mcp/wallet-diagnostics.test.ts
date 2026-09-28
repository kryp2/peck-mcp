import { describe, it, expect } from 'vitest'
import { describeWalletInitFailure } from './wallet-diagnostics.js'

// The exact message Node 24 throws when better-sqlite3 was built for Node 22.
const ABI_ERROR = new Error(
  "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 127. This version of Node.js requires\n' +
  'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n' +
  'the module (for instance, using `npm rebuild` or `npm install`).',
)

describe('describeWalletInitFailure', () => {
  it('flags a native-module ABI mismatch as a reinstall, never as a missing key', () => {
    const f = describeWalletInitFailure('storage', ABI_ERROR, 'v24.19.0')
    expect(f.stage).toBe('storage')
    expect(f.missingKey).toBe(false)
    expect(f.hint).toMatch(/npm rebuild better-sqlite3/)
    expect(f.hint).toMatch(/v24\.19\.0/)
    expect(f.hint).toMatch(/do NOT generate a new key/)
  })

  it('treats any other storage failure as "key is fine, fix storage"', () => {
    const f = describeWalletInitFailure('storage', new Error('SQLITE_CANTOPEN'))
    expect(f.missingKey).toBe(false)
    expect(f.error).toBe('SQLITE_CANTOPEN')
    expect(f.hint).toMatch(/do NOT generate a new key/)
  })

  it('recognises an empty keychain as the only case that needs a new or migrated key', () => {
    const f = describeWalletInitFailure(
      'keychain',
      new Error('No identity key found in keychain (service=peck-agent, account=default) and no ~/.peck/identity.json to migrate.'),
    )
    expect(f.missingKey).toBe(true)
    expect(f.hint).toMatch(/identity\.json/)
  })

  it('does not suggest a new key when the keychain itself is unreachable', () => {
    const f = describeWalletInitFailure('keychain', new Error('Cannot autolaunch D-Bus without X11 $DISPLAY'))
    expect(f.missingKey).toBe(false)
    expect(f.hint).toMatch(/Secret Service/)
    expect(f.hint).toMatch(/Do not generate a new key/)
  })

  it('accepts non-Error throwables', () => {
    expect(describeWalletInitFailure('storage', 'boom').error).toBe('boom')
  })
})
