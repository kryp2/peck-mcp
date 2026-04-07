import { Request, Response as ExpressResponse, NextFunction } from 'express'
import { EventSource } from 'eventsource'

export interface PaymentConfig {
  address: string
  amount: number
  brc103Identity: string
  arcUrl?: string
}

export function requirePayment(config: PaymentConfig) {
  const arcUrl = config.arcUrl || 'https://arc.gorillapool.io'
  
  return async (req: Request, res: ExpressResponse, next: NextFunction) => {
    const txid = req.headers['x-bsv-payment-txid'] as string
    
    if (!txid) {
      res.status(402).set({
        'X-BSV-Payment-Address': config.address,
        'X-BSV-Amount-Satoshis': config.amount.toString(),
        'X-BSV-Payment-Terms': 'single',
        'X-BSV-Service-ID': config.brc103Identity
      }).json({ error: 'Payment Required' })
      return
    }

    try {
      const isValid = await verifyPayment(txid, arcUrl)
      if (isValid) {
        next()
      } else {
        res.status(402).json({ error: 'Payment Invalid or Not Seen' })
      }
    } catch (err) {
      console.error('Error verifying payment:', err)
      res.status(500).json({ error: 'Error verifying payment' })
    }
  }
}

export async function verifyPayment(txid: string, arcUrl: string): Promise<boolean> {
  // Try SSE first, fallback to polling
  return new Promise((resolve) => {
    let resolved = false
    
    // ARC SSE endpoint
    const es = new EventSource(`${arcUrl}/v1/tx/${txid}/stream`)
    
    const cleanup = () => {
      if (es.readyState !== 2) es.close()
    }
    
    es.onmessage = (event: any) => {
      try {
        const data = JSON.parse(event.data)
        if (data.txStatus === 'SEEN_ON_NETWORK' || data.txStatus === 'MINED') {
          if (!resolved) {
            resolved = true
            cleanup()
            resolve(true)
          }
        } else if (data.txStatus === 'REJECTED') {
          if (!resolved) {
            resolved = true
            cleanup()
            resolve(false)
          }
        }
      } catch (err) {}
    }
    
    es.onerror = () => {
      // SSE failed, fallback to polling
      if (!resolved) {
        cleanup()
        fallbackPoll(txid, arcUrl).then(status => {
          if (!resolved) {
            resolved = true
            resolve(status)
          }
        })
      }
    }
    
    // Timeout for SSE connection establishment/first message
    setTimeout(() => {
      if (!resolved) {
        cleanup()
        fallbackPoll(txid, arcUrl).then(status => {
          if (!resolved) {
            resolved = true
            resolve(status)
          }
        })
      }
    }, 2000)
  })
}

async function fallbackPoll(txid: string, arcUrl: string, retries = 5): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${arcUrl}/v1/tx/${txid}`)
      if (res.ok) {
        const data = await res.json()
        if (data.txStatus === 'SEEN_ON_NETWORK' || data.txStatus === 'MINED') {
          return true
        }
        if (data.txStatus === 'REJECTED') {
          return false
        }
      } else if (res.status === 404) {
        // Not found yet, keep polling
      } else {
        console.error(`ARC polling failed with status: ${res.status}`)
      }
    } catch (err) {
      // Ignore fetch errors during polling and just retry
    }
    // Wait before next poll
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

export class PaymentClient {
  private paymentCache: Map<string, string> = new Map()
  
  constructor(private payFn: (address: string, amount: number) => Promise<string>) {}
  
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const cacheKey = url
    let txid = this.paymentCache.get(cacheKey)
    
    const headers = new Headers(options.headers)
    if (txid) {
      headers.set('X-BSV-Payment-TXID', txid)
    }
    
    let res = await fetch(url, { ...options, headers })
    
    if (res.status === 402) {
      const address = res.headers.get('X-BSV-Payment-Address')
      const amountStr = res.headers.get('X-BSV-Amount-Satoshis')
      
      if (!address || !amountStr) {
        throw new Error('402 Response missing payment headers')
      }
      
      const amount = parseInt(amountStr, 10)
      console.log(`[PaymentClient] 402 Payment Required: ${amount} satoshis to ${address}`)
      
      // Perform payment
      txid = await this.payFn(address, amount)
      console.log(`[PaymentClient] Paid! TXID: ${txid}`)
      
      // Cache it
      this.paymentCache.set(cacheKey, txid)
      
      // Retry request
      const retryHeaders = new Headers(options.headers)
      retryHeaders.set('X-BSV-Payment-TXID', txid)
      
      res = await fetch(url, { ...options, headers: retryHeaders })
    }
    
    return res
  }
}