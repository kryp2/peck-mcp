# Phase B — MCP Write-Side Expansion Plan

**Status:** ready to execute. Phase A (unlike/unfollow/repost/message) shipped, 31 tools live as of revision peck-mcp-00022 (v3.1.0). This plan covers the next batch.

**Goal:** bring agents from "can send all social signals" (phase A) to "can be economic + private actors on the graph" (phase B) — DM with real privacy, payments with context binding, and friend relationships.

---

## 0. Cross-check findings from bitcoinschema.org

Before coding, key nuances surfaced during research that affect implementation:

### 0.1 Follow/unfollow field naming — spec vs indexer disagree

The Bitcoin Schema spec (`/docs/schemas/social-actions`) explicitly says:

```
MAP SET app <appname> type follow bapID <bapID> | AIP ...
```

All three relationship actions (follow, unfollow, friend) use **`bapID`**, not `paymail`.

But `peck-indexer-go/parser.go:502` reads `txData.Map.Paymail` for follow and `:510` for unfollow. This means:
- Existing `peck_follow_tx` (uses `bapID` key) is **spec-compliant but not indexed**
- My phase-A `peck_unfollow_tx` (uses `paymail` key to match the broken indexer) is **non-spec**

**Decision needed before phase B ships:** fix the indexer to read `bapID` per spec, then switch `peck_unfollow_tx` from `paymail` back to `bapID`. This is 2 lines in parser.go. Without this fix, follow/unfollow are broken regardless of phase B.

### 0.2 DMs are unencrypted by default in the spec

The spec format for private DM:
```
B <content> <mediaType> <encoding> | MAP SET app type message context bapID bapID <recipient> | AIP ...
```

**Encryption is NOT specified.** The spec only defines how a message is *addressed* (context=bapID) — privacy is left to implementers. For real privacy, `content` must be ECIES-encrypted client-side using the recipient's pubkey, and only the recipient can decrypt.

### 0.3 Payment is real BSV transfer + MAP metadata

Payment tx shape (from spec + peck-indexer-go parser inspection):
- **Real P2PKH output** to recipient with N sats (this is where the money moves)
- **OP_RETURN output** with `MAP SET app type payment context tx tx <context_txid>`
- **Change output** back to sender

`peck-indexer-go/parser.go:475` sums ALL outputs in the tx to get amount. So the recipient must receive via a normal P2PKH output, not via OP_RETURN data fields. This is different from post/like/message txs which are OP_RETURN-only with 0-sat data output.

**Implication:** `broadcastScript()` in peck-mcp-remote.ts doesn't handle recipient outputs — it's hardcoded to one OP_RETURN (index 0) + one change output (index 1). Phase B needs either:
- A `broadcastPayment(script, key, recipientAddress, amount)` variant, or
- A parameterized `broadcastScript(script, key, extraOutputs?)` refactor

The variant is lower-risk for the hackathon.

### 0.4 BAP-ID vs plain pubkey — pragma for agents

The spec talks about BAP-IDs (Bitcoin Attestation Protocol identifiers — hash chains rooted in a pubkey). Our peck-mcp agents currently use plain BSV P2PKH addresses (e.g. `1P6NgC9D...`). They do NOT mint BAP-IDs.

**Pragma:** peck_dm_tx and peck_friend_tx should accept `recipient_pubkey` (hex) as input. If recipient has a BAP-ID, caller can pass it as the bapID field value; otherwise pass the plain pubkey hex. Document this as "BAP-compatible identifier — hex pubkey works for non-BAP agents".

### 0.5 @bsv/sdk has ECIES in compat/

Path: `node_modules/@bsv/sdk/src/compat/ECIES.ts`. Import via `import { ECIES } from '@bsv/sdk/compat'` or whatever the package exports. Verify the import path before using — the SDK surface may have changed since the test file was written.

---

## 1. New write tools (phase B)

### 1.1 `peck_friend_tx(target_bapid, target_pubkey, signing_key)` ⏱️ ~10 min

**Spec format:**
```
MAP SET app <app> type friend bapID <bapID> publicKey <publicFriendKey> | AIP ...
```

**Parser check:** `peck-indexer-go/parser.go:518` reads both `BapID` and `PubKey`. Match.

**Implementation:**
```typescript
// schema
{
  name: 'peck_friend_tx',
  description: 'Establish a two-way friend relationship via BAP-ID + pubkey. ...',
  inputSchema: {
    type: 'object' as const,
    properties: {
      target_bapid: { type: 'string', description: 'Target agent BAP-ID (or hex pubkey for non-BAP agents).' },
      target_pubkey: { type: 'string', description: 'Target agent pubkey (hex) — used for future encrypted comms.' },
      signing_key: { type: 'string' },
      agent_app: { type: 'string' },
    },
    required: ['target_bapid', 'target_pubkey', 'signing_key'],
  },
}

// handler
case 'peck_friend_tx': {
  const { target_bapid, target_pubkey, signing_key } = args || {}
  if (!signing_key || !target_bapid || !target_pubkey) {
    text = JSON.stringify({ error: 'target_bapid, target_pubkey, signing_key required' })
    break
  }
  try {
    const key = PrivateKey.fromHex(signing_key)
    const script = buildMapOnly('friend', {
      bapID: String(target_bapid),
      publicKey: String(target_pubkey),
    }, key, args?.agent_app || 'peck.agents')
    text = await broadcastScript(script, key)
  } catch (e: any) {
    text = JSON.stringify({ error: e.message })
  }
  break
}
```

**Risk:** low. Trivial addition, matches existing pattern.

### 1.2 `peck_dm_tx(recipient_bapid, recipient_pubkey, content, signing_key, encrypt?)` ⏱️ ~30 min

**Spec format:**
```
B <ciphertext> <mediaType> <encoding> | MAP SET app type message context bapID bapID <recipient> | AIP ...
```

**Implementation plan:**

1. Add ECIES import at top of file:
   ```typescript
   import { ECIES } from '@bsv/sdk/compat'  // verify actual export path
   ```

2. Add new helper `buildDM()`:
   ```typescript
   function buildDM(
     content: string,
     recipientBapId: string,
     recipientPubkey: string | null,  // if set and encrypt=true, ECIES-encrypt
     signingKey: PrivateKey,
     encrypt: boolean,
     app?: string,
   ): Script {
     let payload = content
     if (encrypt && recipientPubkey) {
       // ECIES: encrypt with recipient's pubkey, sender's privkey
       // Output is a buffer — encode as base64 or hex for B protocol
       const pub = PublicKey.fromString(recipientPubkey)
       const ct = ECIES.electrumEncrypt(Buffer.from(content, 'utf8'), pub, signingKey)
       payload = ct.toString('base64')
     }
     const s = new Script()
     s.writeOpCode(OP.OP_FALSE)
     s.writeOpCode(OP.OP_RETURN)
     // B protocol with ciphertext (or plaintext if encrypt=false)
     pushData(s, PROTO_B)
     pushData(s, payload)
     pushData(s, encrypt ? 'application/octet-stream' : 'text/markdown')
     pushData(s, encrypt ? 'base64' : 'UTF-8')
     s.writeBin([PIPE])
     // MAP SET with context=bapID
     pushData(s, PROTO_MAP); pushData(s, 'SET')
     pushData(s, 'app'); pushData(s, app || APP_NAME)
     pushData(s, 'type'); pushData(s, 'message')
     pushData(s, 'context'); pushData(s, 'bapID')
     pushData(s, 'bapID'); pushData(s, recipientBapId)
     // AIP
     const addr = signingKey.toAddress(NETWORK === 'main' ? 'mainnet' : 'testnet') as string
     const sig = BSM.sign(Array.from(createHash('sha256').update(payload).digest()), signingKey)
     s.writeBin([PIPE])
     pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
     return s
   }
   ```

3. Schema:
   ```typescript
   {
     name: 'peck_dm_tx',
     description: 'Send a direct message to a specific agent/user via bapID context. ' +
       'By default, ECIES-encrypts the content with the recipient\'s pubkey so only they can read it. ' +
       'Set encrypt=false for addressed-but-public messages (e.g. mentions). ' +
       'The addressing uses MAP context=bapID per Bitcoin Schema spec.',
     inputSchema: {
       type: 'object' as const,
       properties: {
         recipient_bapid: { type: 'string', description: 'Recipient BAP-ID or hex pubkey.' },
         recipient_pubkey: { type: 'string', description: 'Recipient pubkey hex (required if encrypt=true).' },
         content: { type: 'string', description: 'Plaintext message — will be encrypted if encrypt=true.' },
         encrypt: { type: 'boolean', description: 'ECIES-encrypt content with recipient_pubkey (default true).' },
         signing_key: { type: 'string' },
         agent_app: { type: 'string' },
       },
       required: ['recipient_bapid', 'content', 'signing_key'],
     },
   }
   ```

4. Handler:
   ```typescript
   case 'peck_dm_tx': {
     const { recipient_bapid, recipient_pubkey, content, signing_key } = args || {}
     const encrypt = args?.encrypt !== false
     if (!signing_key || !recipient_bapid || !content) {
       text = JSON.stringify({ error: 'recipient_bapid, content, signing_key required' })
       break
     }
     if (encrypt && !recipient_pubkey) {
       text = JSON.stringify({ error: 'recipient_pubkey required when encrypt=true (default)' })
       break
     }
     try {
       const key = PrivateKey.fromHex(signing_key)
       const script = buildDM(
         String(content),
         String(recipient_bapid),
         encrypt ? String(recipient_pubkey) : null,
         key,
         encrypt,
         args?.agent_app || 'peck.agents',
       )
       text = await broadcastScript(script, key)
     } catch (e: any) {
       text = JSON.stringify({ error: e.message })
     }
     break
   }
   ```

**Risks:**
- ECIES import path in @bsv/sdk may not be where I expect. Check `node_modules/@bsv/sdk/package.json` exports field before deploy.
- Recipient can't decrypt unless they know the sender's pubkey too (ECIES is asymmetric). Include sender's address in the AIP field as usual — recipient derives sender pubkey from sig + hash, or we send pubkey separately.
- Content integrity: the signature in AIP is over the ciphertext hash, so authenticity of the ciphertext is verifiable without decryption. Good.

**Companion read path (NOT in phase B):** peck_dm_inbox(my_address, my_private_key) would fetch all messages where MAP context=bapID AND bapID=<my_pubkey or bapid> and attempt to ECIES-decrypt each. Requires an overlay endpoint `/v1/messages?recipient_bapid=X` or client-side filtering. Defer.

### 1.3 `peck_send_payment_tx(recipient_address, amount_sat, context_txid?, signing_key)` ⏱️ ~45 min

**Spec format (OP_RETURN metadata):**
```
MAP SET app type payment context tx tx <context_txid> | AIP ...
```

**Actual tx shape:**
- Input: sender's cached UTXO
- Output 0: OP_RETURN with MAP payment metadata (0 sat)
- Output 1: P2PKH to recipient_address (amount_sat) ← **the actual money**
- Output 2: P2PKH change back to sender
- Sign with sender's key

**Parser check:** `peck-indexer-go/parser.go:475` sums all outputs. Recipient output + change both count. Parser saves to `payments` table with `reference_tx` = context_txid, `sender`, `amount`, `timestamp`.

**Implementation plan:**

1. Add a new variant of `broadcastScript` that accepts extra outputs before change:
   ```typescript
   async function broadcastPayment(
     script: Script,  // OP_RETURN with MAP payment metadata
     key: PrivateKey,
     recipientAddress: string,
     amountSat: number,
   ): Promise<string> {
     const address = key.toAddress(NETWORK === 'main' ? 'mainnet' : 'testnet') as string
     const utxo = await getUtxo(address)
     if (!utxo) return JSON.stringify({ error: `No UTXOs for ${address}` })

     const parentTx = Transaction.fromHex(utxo.rawHex)
     const tx = new Transaction()
     tx.addInput({
       sourceTransaction: parentTx,
       sourceOutputIndex: utxo.vout,
       unlockingScriptTemplate: new P2PKH().unlock(key),
     })

     // Output 0: OP_RETURN metadata
     tx.addOutput({ lockingScript: script, satoshis: 0 })
     // Output 1: recipient P2PKH
     tx.addOutput({ lockingScript: new P2PKH().lock(recipientAddress), satoshis: amountSat })

     // Fee — factor in extra output
     const estSize = 150 + 34 * 3 + (script.toHex().length / 2) + 10
     const fee = Math.max(50, Math.ceil(estSize * 100 / 1000))
     const change = utxo.satoshis - amountSat - fee
     if (change < 1) {
       return JSON.stringify({ error: `Insufficient funds. Have ${utxo.satoshis} sat, need ${amountSat + fee}.` })
     }

     // Output 2: change back to self
     tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: change })

     await tx.sign()
     const rawHex = tx.toHex()
     const txid = tx.id('hex') as string

     // Broadcast via ARC (same as broadcastScript)
     // ... (copy ARC logic from broadcastScript)

     // IMPORTANT: cache the change output at index 2, not 1
     if (success) {
       utxoCache.set(address, {
         txid,
         vout: 2,  // change is at index 2 in payment txs
         satoshis: change,
         rawHex,
       })
     }
     return JSON.stringify({ success, txid, ... })
   }
   ```

2. Add helper for payment OP_RETURN:
   ```typescript
   function buildPaymentOpReturn(contextTxid: string | null, signingKey: PrivateKey, app?: string): Script {
     const fields: Record<string, string> = {}
     if (contextTxid) {
       fields.context = 'tx'
       fields.tx = contextTxid
     }
     return buildMapOnly('payment', fields, signingKey, app)
   }
   ```

3. Schema:
   ```typescript
   {
     name: 'peck_send_payment_tx',
     description: 'Send a BSV payment to another address, optionally bound to a context tx ' +
       '(e.g. tipping a post, paying for a function call). The payment is a real on-chain ' +
       'value transfer plus OP_RETURN metadata that links it to the context. Use this for ' +
       'tips, service payments, and economic signaling between agents.',
     inputSchema: {
       type: 'object' as const,
       properties: {
         recipient_address: { type: 'string', description: 'BSV P2PKH address of recipient.' },
         amount_sat: { type: 'number', description: 'Amount in satoshis. Must be > 0.' },
         context_txid: { type: 'string', description: 'Optional: txid this payment is in response to (a post, function call, etc).' },
         signing_key: { type: 'string' },
         agent_app: { type: 'string' },
       },
       required: ['recipient_address', 'amount_sat', 'signing_key'],
     },
   }
   ```

4. Handler dispatches to `broadcastPayment` instead of `broadcastScript`.

**Risks:**
- **UTXO cache index drift:** broadcastScript puts change at vout=1, broadcastPayment at vout=2. The utxoCache has ONE entry per address, and getUtxo() returns it blindly. So after a payment, the next non-payment call must still find the right change. If I update `utxoCache.set(address, {vout: 2, ...})` correctly, this works — the next call reads cached UTXO and uses its `vout` field. Verified: broadcastScript reads `utxo.vout` dynamically. No hardcoded index. **Good.**
- **Dust threshold:** ARC enforces min output of ~1 sat. amount_sat=1 is valid, amount_sat=0 is not. Document min.
- **Fee underestimation:** my estSize formula is rough. If it undercuts, tx rejected. Add a safety margin.
- **Balance check:** user could call with amount > balance. Currently returns error cleanly.

---

## 2. Bug fixes to pair with phase B

### 2.1 Fix peck-indexer-go follow/unfollow to use bapID

File: `peck-indexer-go/parser.go`

```go
// BEFORE (line 502)
case "follow":
    if txData.Map.Paymail != "" {
        saveFollow(FollowData{
            Follower:  signer,
            Following: txData.Map.Paymail,
        })
    }

// AFTER
case "follow":
    if txData.Map.BapID != "" {
        saveFollow(FollowData{
            Follower:  signer,
            Following: txData.Map.BapID,
        })
    }
```

Same change for `case "unfollow"` at ~line 510.

**Coordinate with Thomas before shipping** — he said not to touch indexer. This is a spec-compliance fix, not a refactor, and it unblocks 4 write tools (follow, unfollow, friend, future DM-inbox). Recommend doing it together with phase B.

### 2.2 Flip peck_unfollow_tx to bapID once parser is fixed

After 2.1 lands:

```typescript
// In peck-mcp-remote.ts
// peck_unfollow_tx schema: target_paymail → target_bapid
// Handler: paymail → bapID key in buildMapOnly
```

Same file path, same build pattern as `peck_follow_tx`.

---

## 3. Optional polish (if time)

### 3.1 `peck_dm_inbox(my_address, my_private_key)` — decrypt path

Counterpart to peck_dm_tx. Fetches `/v1/messages?recipient_bapid=X` (requires new overlay endpoint) and ECIES-decrypts each. Defer until overlay gains the filter and we have 30 min to spare.

### 3.2 `peck_help()` — tool discovery

Lists all tools with one-line descriptions and an example per tool. Pure MCP-side. Good for new-agent onboarding but low priority compared to phase B capabilities.

### 3.3 Integration test script

`scripts/test-phase-b.sh` that smoke-tests `peck_friend_tx`, `peck_dm_tx` (with round-trip decrypt via a second test identity), and `peck_send_payment_tx` (with a trivial amount). Good for confidence before pitch demo.

---

## 4. Execution order when we resume

1. **Verify current state** — `curl https://mcp.peck.to/` returns version 3.1.0, 31 tools. If not, something drifted.
2. **Verify @bsv/sdk ECIES export path** — `grep -r "export.*ECIES" node_modules/@bsv/sdk/src/compat/` or inspect `package.json` exports field. Update import statement accordingly.
3. **Coordinate with Thomas** on section 2.1 (indexer follow/unfollow fix). Either have the other agent ship it in parallel, or skip and live with follow/unfollow being broken.
4. **Implement 1.1 (peck_friend_tx)** — fastest win, 10 min. Type-check, commit.
5. **Implement 1.2 (peck_dm_tx)** — includes new buildDM helper, ECIES wiring. Type-check, commit.
6. **Implement 1.3 (peck_send_payment_tx)** — includes new broadcastPayment helper. Extra care on UTXO cache index and fee calculation. Type-check, commit.
7. **Version bump 3.1.0 → 3.2.0** in all three places (top-level mcpServer, createSessionServer, health JSON).
8. **Deploy** — `gcloud run deploy peck-mcp --source . --region=europe-west1 --quiet`. Wait for 100% traffic routing.
9. **Smoke test via HTTP handshake** (or via `/mcp` refresh in a fresh claude-code session):
   - `peck_friend_tx(target_bapid=self_pubkey, target_pubkey=self_pubkey, signing_key)` — friend yourself as a no-op smoke test
   - `peck_dm_tx(recipient_bapid=<test-identity>, recipient_pubkey=<hex>, content='ping', signing_key)` — requires a second test identity to verify round-trip
   - `peck_send_payment_tx(recipient_address=<thomas's test addr>, amount_sat=10, context_txid=<my first post>, signing_key)` — tips thomas 10 sat bound to a post
10. **Verify on peck.to** — check that payment shows up with context_txid binding
11. **Commit smoke-test log** — note txids and indexer verification status

---

## 5. What this unlocks for the hackathon pitch

With phase B done, the pitch slide "agents as first-class citizens" becomes concrete:
- **Same chain as humans** ✅ (since day 5 pivot)
- **All social signals** ✅ (phase A)
- **Economic actors** ✅ (send_payment_tx — tips, function-call payments)
- **Private channels** ✅ (dm_tx with ECIES)
- **Trust graph** ✅ (friend_tx — basis for reputation)

The demo script: agent A discovers agent B's registered function → sends `peck_friend_tx` → sends encrypted `peck_dm_tx` with the actual request → B responds → A sends `peck_send_payment_tx` bound to the request txid → the whole negotiation is on-chain, verifiable, and private where needed. **That's Agent Commons in one demo.**

---

## 6. Starting balance reminder

As of end of this session: peck-mcp identity `1P6NgC9DwMPLbUZTZDPu2xUNH6EKGpN9sS` has **7214 sat**. Each phase-B smoke test costs ~70-100 sat. Budget ~500 sat for the full smoke suite. No refill needed.

---

## 7. Files modified

- `src/mcp/peck-mcp-remote.ts` — new helpers (buildDM, buildPaymentOpReturn, broadcastPayment), three new tool schemas, three new case handlers, version bump
- `peck-indexer-go/parser.go` — OPTIONAL: follow/unfollow bapID fix (section 2.1)

Nothing else should need touching.
