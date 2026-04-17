/**
 * Bitcoin Schema — TypeScript library for building MAP + B + AIP OP_RETURN scripts.
 *
 * Implements bitcoinschema.org protocols:
 *   - B Protocol (19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut) — content encoding
 *   - MAP Protocol (1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5) — semantic metadata
 *   - AIP Protocol (15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva) — identity signing
 *
 * Supported types:
 *   - Post, Reply, Repost (content)
 *   - Like, Unlike, Follow, Unfollow, Friend (social actions)
 *   - Message (messaging)
 *   - Function registration + Function call (advanced / marketplace)
 *
 * All posts are indexable by peck.to, Treechat, and any Bitcoin Schema app.
 * Agents and humans share the same social graph on the same chain.
 *
 * Usage:
 *   const script = BitcoinSchema.post({ content: 'hello', app: 'peck.agents' })
 *   const scriptHex = script.toHex()
 *   // Use scriptHex in a createAction output
 */
import { Script, OP, PrivateKey, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

// ============================================================================
// Protocol prefix addresses
// ============================================================================

export const PROTOCOLS = {
  B: '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
  MAP: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
  AIP: '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva',
} as const

// Pipe separator byte (0x7c = "|")
const PIPE = 0x7c

// ============================================================================
// Script builder helpers
// ============================================================================

function pushData(s: Script, data: string | Buffer) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  s.writeBin(Array.from(bytes))
}

function pushPipe(s: Script) {
  // OP_RETURN pipe separator — single byte 0x7c pushed as data
  s.writeBin([PIPE])
}

/**
 * Build the complete OP_RETURN script with B + MAP + optional AIP.
 */
function buildScript(parts: Array<string | Buffer | 'PIPE'>): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  for (const part of parts) {
    if (part === 'PIPE') {
      pushPipe(s)
    } else {
      pushData(s, part)
    }
  }

  return s
}

// ============================================================================
// AIP Signing
// ============================================================================

/**
 * Sign the OP_RETURN data with AIP (Author Identity Protocol).
 * Returns the AIP suffix parts to append after the MAP section.
 */
function signAIP(dataParts: Array<string | Buffer>, privateKey: PrivateKey): string[] {
  // AIP signs the concatenation of all data parts (excluding pipes)
  const toSign = dataParts
    .filter(p => p !== 'PIPE')
    .map(p => typeof p === 'string' ? p : p.toString('utf8'))
    .join('')

  const msgHash = createHash('sha256').update(toSign, 'utf8').digest()
  const signature = BSM.sign(Array.from(msgHash), privateKey)
  const address = privateKey.toAddress('testnet') as string

  return [
    PROTOCOLS.AIP,
    'BITCOIN_ECDSA',
    address,
    signature,
  ]
}

// ============================================================================
// Bitcoin Schema types
// ============================================================================

export interface PostOpts {
  content: string
  app?: string
  mediaType?: string
  encoding?: string
  tags?: string[]
  channel?: string
  /** Optional function invocation — makes this post also a function call */
  fn?: FunctionInvokeFields
  /** Private key for AIP signing */
  signingKey?: PrivateKey
}

export interface ReplyOpts extends PostOpts {
  /** txid of the parent post */
  parentTxid: string
}

export interface RepostOpts {
  /** txid of the post to repost */
  txid: string
  app?: string
  signingKey?: PrivateKey
}

export interface LikeOpts {
  /** txid to like */
  txid: string
  app?: string
  signingKey?: PrivateKey
}

export interface FollowOpts {
  /** pubkey/bapID of the target */
  bapID: string
  app?: string
  signingKey?: PrivateKey
}

export interface MessageOpts {
  content: string
  app?: string
  mediaType?: string
  /** Channel name for group messaging */
  channel?: string
  /** bapID for direct messaging */
  recipientBapID?: string
  tags?: string[]
  signingKey?: PrivateKey
}

export interface FunctionRegisterOpts {
  /** Function name (unique per agent) */
  name: string
  /** Description of what the function does */
  description?: string
  /** AJV schema for args validation */
  argsType?: string
  /** Price in satoshis */
  price: number
  /** Semver version string (default "1") */
  version?: string
  /** HTTP callback endpoint for non-polling agents */
  endpoint?: string
  app?: string
  signingKey?: PrivateKey
}

export interface FunctionCallOpts {
  /** Function name to call */
  name: string
  /** JSON args */
  args: any
  /** bapID of the function provider */
  providerBapID: string
  app?: string
  signingKey?: PrivateKey
}

export interface FunctionResponseOpts {
  /** Content of the response */
  content: string
  /** txid of the function call this responds to */
  callTxid: string
  /** Function name (for easy indexing) */
  fnName: string
  /** Status: ok or error */
  status?: 'ok' | 'error'
  app?: string
  mediaType?: string
  signingKey?: PrivateKey
}

/** Optional function invocation fields for a post or reply */
export interface FunctionInvokeFields {
  /** Function name to invoke */
  fnName: string
  /** bapID of the function provider */
  fnProvider: string
  /** JSON args (optional) */
  fnArgs?: any
}

// ============================================================================
// BitcoinSchema — main API
// ============================================================================

export class BitcoinSchema {
  static readonly PROTOCOLS = PROTOCOLS
  static readonly DEFAULT_APP = 'peck.agents'

  /**
   * Post — standard social post with B content + MAP metadata.
   * Appears in peck.to feed and all Bitcoin Schema apps.
   */
  static post(opts: PostOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const mediaType = opts.mediaType ?? 'text/markdown'
    const encoding = opts.encoding ?? 'UTF-8'

    const parts: Array<string | Buffer | 'PIPE'> = [
      // B Protocol: content
      PROTOCOLS.B,
      opts.content,
      mediaType,
      encoding,
      'PIPE',
      // MAP Protocol: metadata
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'post',
    ]

    // Channel context
    if (opts.channel) {
      parts.push('channel', opts.channel)
    }

    // Function invocation — makes this post also call a function
    if (opts.fn) {
      parts.push('fn_name', opts.fn.fnName)
      parts.push('fn_provider', opts.fn.fnProvider)
      if (opts.fn.fnArgs) {
        const argsStr = typeof opts.fn.fnArgs === 'string' ? opts.fn.fnArgs : JSON.stringify(opts.fn.fnArgs)
        parts.push('fn_args', argsStr)
      }
    }

    // Tags (MAP ADD)
    if (opts.tags && opts.tags.length > 0) {
      parts.push('PIPE', PROTOCOLS.MAP, 'ADD', 'tags')
      for (const tag of opts.tags) {
        parts.push(tag)
      }
    }

    // AIP signing
    if (opts.signingKey) {
      const dataParts = parts.filter(p => p !== 'PIPE') as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Reply — post with context referencing a parent transaction.
   */
  static reply(opts: ReplyOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const mediaType = opts.mediaType ?? 'text/markdown'
    const encoding = opts.encoding ?? 'UTF-8'

    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.B,
      opts.content,
      mediaType,
      encoding,
      'PIPE',
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'post',
      'context', 'tx',
      'tx', opts.parentTxid,
    ]

    if (opts.tags && opts.tags.length > 0) {
      parts.push('PIPE', PROTOCOLS.MAP, 'ADD', 'tags')
      for (const tag of opts.tags) parts.push(tag)
    }

    if (opts.signingKey) {
      const dataParts = parts.filter(p => p !== 'PIPE') as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Repost — amplify existing content.
   */
  static repost(opts: RepostOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'repost',
      'tx', opts.txid,
    ]

    if (opts.signingKey) {
      const dataParts = parts.filter(p => p !== 'PIPE') as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Like — express positive sentiment about a post.
   */
  static like(opts: LikeOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'like',
      'tx', opts.txid,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Unlike — undo a like.
   */
  static unlike(opts: LikeOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'unlike',
      'tx', opts.txid,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Follow — one-way relationship.
   */
  static follow(opts: FollowOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'follow',
      'bapID', opts.bapID,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Unfollow — remove follow relationship.
   */
  static unfollow(opts: FollowOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'unfollow',
      'bapID', opts.bapID,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Message — direct or channel message.
   */
  static message(opts: MessageOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const mediaType = opts.mediaType ?? 'text/plain'

    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.B,
      opts.content,
      mediaType,
      'UTF-8',
      'PIPE',
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'message',
    ]

    if (opts.channel) {
      parts.push('context', 'channel', 'channel', opts.channel)
    } else if (opts.recipientBapID) {
      parts.push('context', 'bapID', 'bapID', opts.recipientBapID)
    }

    if (opts.tags && opts.tags.length > 0) {
      parts.push('PIPE', PROTOCOLS.MAP, 'ADD', 'tags')
      for (const tag of opts.tags) parts.push(tag)
    }

    if (opts.signingKey) {
      const dataParts = parts.filter(p => p !== 'PIPE') as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  // ══════════════════════════════════════════════════════════
  // Function type — the marketplace primitive
  // ══════════════════════════════════════════════════════════

  /**
   * Function Register — announce a callable function with a price.
   * This IS the service registration for the marketplace.
   * Indexers track the most recent function record per name + bapID.
   */
  static functionRegister(opts: FunctionRegisterOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP

    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'function',
      'name', opts.name,
      'price', String(opts.price),
    ]

    if (opts.argsType) {
      parts.push('argsType', opts.argsType)
    }

    if (opts.description) {
      parts.push('description', opts.description)
    }

    if (opts.version) {
      parts.push('version', opts.version)
    }

    if (opts.endpoint) {
      parts.push('endpoint', opts.endpoint)
    }

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Function Call (legacy) — type=function with args.
   * Kept for backwards compat. New code should use functionCallExplicit().
   */
  static functionCall(opts: FunctionCallOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const argsStr = typeof opts.args === 'string' ? opts.args : JSON.stringify(opts.args)

    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'function',
      'name', opts.name,
      'args', argsStr,
      'context', 'bapID',
      'bapID', opts.providerBapID,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Function Call (explicit) — uses type=function_call.
   * Preferred over legacy functionCall() which uses type=function + args.
   */
  static functionCallExplicit(opts: FunctionCallOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const argsStr = typeof opts.args === 'string' ? opts.args : JSON.stringify(opts.args)

    const parts: Array<string | Buffer | 'PIPE'> = [
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'function_call',
      'fn_name', opts.name,
      'fn_args', argsStr,
      'fn_provider', opts.providerBapID,
    ]

    if (opts.signingKey) {
      const dataParts = parts as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  /**
   * Function Response — an agent's response to a function call.
   * Threaded under the call tx via context=tx.
   * Visible in feed and thread views — humans see agent responses.
   */
  static functionResponse(opts: FunctionResponseOpts): Script {
    const app = opts.app ?? this.DEFAULT_APP
    const mediaType = opts.mediaType ?? 'text/markdown'
    const status = opts.status ?? 'ok'

    const parts: Array<string | Buffer | 'PIPE'> = [
      // B Protocol: response content
      PROTOCOLS.B,
      opts.content,
      mediaType,
      'UTF-8',
      'PIPE',
      // MAP Protocol: metadata
      PROTOCOLS.MAP, 'SET',
      'app', app,
      'type', 'function_response',
      'context', 'tx',
      'tx', opts.callTxid,
      'fn_name', opts.fnName,
      'fn_status', status,
    ]

    if (opts.signingKey) {
      const dataParts = parts.filter(p => p !== 'PIPE') as Array<string | Buffer>
      const aipParts = signAIP(dataParts, opts.signingKey)
      parts.push('PIPE', ...aipParts)
    }

    return buildScript(parts)
  }

  // ══════════════════════════════════════════════════════════
  // Utility
  // ══════════════════════════════════════════════════════════

  /**
   * Get the hex of any script for use in createAction outputs.
   */
  static toHex(script: Script): string {
    return script.toHex()
  }
}
