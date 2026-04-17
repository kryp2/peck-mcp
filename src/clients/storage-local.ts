/**
 * storage-local — minimal TS client for the local UHRP storage stack.
 *
 * Targets:
 *   - storage-server (uhrp-storage-server) at http://localhost:8090
 *   - fake-gcs (fsouza/fake-gcs-server)   at http://localhost:4443
 *
 * The hackathon dev stack uses fake-gcs as the GCS-compatible blob backend.
 * Storage-server's /upload returns a V4 signed URL pointing at the bucket
 * directly, but fake-gcs only accepts uploads via the JSON API path
 * (/upload/storage/v1/b/<bucket>/o), so this client BYPASSES storage-server's
 * upload endpoint and writes blobs directly to fake-gcs.
 *
 * In mainnet (real storage.peck.to + real GCS) the same client uses the
 * proper signed-URL flow — toggle via STORAGE_LOCAL_URL env or `useFakeGcs`.
 *
 * The blob handle returned is a UHRP-style identifier:
 *   `blob:<sha256-hex>`
 * which is what memory-agent v2 stamps into OP_RETURN. Reads resolve back
 * via fake-gcs's GET endpoint.
 */
import crypto from 'node:crypto'
import { PeckBrcClient } from './peck-brc-client.js'

export interface StorageLocalOptions {
  storageUrl?: string  // storage-server URL (used for /quote, /find, /advertise)
  fakeGcsUrl?: string  // fake-gcs URL (used for direct PUT/GET)
  bucket?: string
  /**
   * Optional PeckBrcClient — used for storage-server calls when targeting
   * prod storage.peck.to (requires BRC-104 auth + 402 payment handling).
   * fake-gcs calls are always plain HTTP since fake-gcs has no auth.
   */
  authClient?: PeckBrcClient
}

export interface BlobUploadResult {
  /** sha256 hex of the bytes — also the object name suffix and the handle. */
  hash: string
  /** "blob:<hash>" — what memory-agent stamps into OP_RETURN. */
  handle: string
  /** Object name in the bucket (cdn/<hash>). */
  objectName: string
  /** Size in bytes. */
  size: number
  /** Direct fake-gcs URL the bytes can be fetched from. */
  url: string
}

export class StorageLocal {
  readonly storageUrl: string
  readonly fakeGcsUrl: string
  readonly bucket: string
  readonly authClient: PeckBrcClient

  constructor(opts: StorageLocalOptions = {}) {
    this.storageUrl = (opts.storageUrl ?? process.env.STORAGE_LOCAL_URL ?? 'http://localhost:8090').replace(/\/$/, '')
    this.fakeGcsUrl = (opts.fakeGcsUrl ?? process.env.FAKE_GCS_URL ?? 'http://localhost:4443').replace(/\/$/, '')
    this.bucket = opts.bucket ?? process.env.STORAGE_LOCAL_BUCKET ?? 'peck-storage-local'
    this.authClient = opts.authClient ?? PeckBrcClient.fromEnv()
  }

  /**
   * Ensure the bucket exists in fake-gcs. fake-gcs doesn't auto-create
   * buckets on first reference via signed URLs (or via the upload API
   * paths in some versions), so we POST it explicitly. Idempotent — a
   * 409 conflict means it already exists, which is fine.
   */
  async ensureBucket(): Promise<void> {
    const r = await fetch(`${this.fakeGcsUrl}/storage/v1/b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.bucket }),
    })
    if (!r.ok && r.status !== 409) {
      const text = await r.text()
      throw new Error(`fake-gcs ensureBucket: ${r.status} ${text}`)
    }
  }

  /**
   * Upload raw bytes to fake-gcs via the JSON API. Object is named
   * `cdn/<sha256-hex>`. The handle returned is `blob:<sha256-hex>`.
   *
   * Idempotent — uploading the same bytes twice produces the same handle.
   */
  async uploadBytes(bytes: Buffer): Promise<BlobUploadResult> {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const objectName = `cdn/${hash}`
    const url = `${this.fakeGcsUrl}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    if (!r.ok) {
      // Auto-create bucket if missing and retry once.
      if (r.status === 404) {
        await this.ensureBucket()
        const r2 = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        })
        if (!r2.ok) throw new Error(`fake-gcs upload retry: ${r2.status} ${await r2.text()}`)
      } else {
        throw new Error(`fake-gcs upload: ${r.status} ${await r.text()}`)
      }
    }
    return {
      hash,
      handle: `blob:${hash}`,
      objectName,
      size: bytes.length,
      url: `${this.fakeGcsUrl}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
    }
  }

  /**
   * Fetch raw bytes by handle. Accepts either a `blob:<hash>` handle
   * (preferred) or a bare hash.
   */
  async readBytes(handle: string): Promise<Buffer> {
    const hash = handle.startsWith('blob:') ? handle.slice('blob:'.length) : handle
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad blob handle: ${handle}`)
    const objectName = `cdn/${hash}`
    const url = `${this.fakeGcsUrl}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`
    const r = await fetch(url)
    if (!r.ok) throw new Error(`fake-gcs read ${handle}: ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }

  /**
   * Routed upload via storage-shim. Returns the same handle/hash as
   * uploadBytes, plus a fee_receipt_txid the shim wrote on its own.
   * Use this when you want every storage call to count as a marketplace
   * transaction with its own on-chain receipt.
   */
  async paidUploadBytes(
    shimUrl: string,
    bytes: Buffer,
  ): Promise<BlobUploadResult & { fee_receipt_txid: string | null; price_paid_sats: number }> {
    const r = await fetch(`${shimUrl.replace(/\/$/, '')}/paid-upload-bytes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value_b64: bytes.toString('base64') }),
    })
    if (!r.ok) throw new Error(`storage-shim ${shimUrl}: ${r.status} ${await r.text()}`)
    const j = await r.json() as any
    return {
      hash: j.hash,
      handle: j.handle,
      objectName: `cdn/${j.hash}`,
      size: j.size,
      url: j.blob_url,
      fee_receipt_txid: j.fee_receipt_txid,
      price_paid_sats: j.price_paid_sats,
    }
  }

  /**
   * Storage-server health check. Hits /quote with a tiny request — it's the
   * cheapest pre-auth endpoint that exercises the actual server pipeline.
   */
  async health(): Promise<{ ok: boolean; quote?: number; error?: string }> {
    try {
      const r = await this.authClient.fetch(`${this.storageUrl}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ fileSize: 1, retentionPeriod: 1 }),
      })
      if (!r.ok) return { ok: false, error: `quote http ${r.status}` }
      const body = await r.json() as any
      return { ok: true, quote: body.quote }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }
}
