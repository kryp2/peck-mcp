/**
 * Incoming BRC-29 payments on the other public message servers.
 *
 * bitcoin-agent-wallet polls and listens only on its own MESSAGEBOX_URL
 * (https://msg.peck.to). BSV Desktop, BSV Browser and Peck OS send PeerPay
 * through https://gmb.bsvblockchain.tech by default, so a payment from any of
 * them sat unread and the agent wallet never saw it. This polls the other hosts
 * too, one PeerPayClient per host, so each payment is acknowledged on the host
 * it came from. The host list matches peck-os src/passkey/hosts.ts.
 */
import { PeerPayClient } from '@bsv/message-box-client'
import type { WalletInterface } from '@bsv/sdk'

export const EXTRA_PAYMENT_HOSTS = [
  'https://gmb.bsvblockchain.tech',
  'https://messagebox.babbage.systems',
]

/** The part of PeerPayClient this module uses; tests pass fakes. */
export interface PaymentInbox {
  listIncomingPayments(): Promise<Array<{ messageId: string, token?: { amount?: number } }>>
  acceptPayment(payment: any): Promise<unknown>
}

export function openInboxes(
  walletClient: WalletInterface,
  hosts: string[] = EXTRA_PAYMENT_HOSTS,
  make: (host: string) => PaymentInbox = host => new PeerPayClient({ walletClient, messageBoxHost: host }) as unknown as PaymentInbox,
): Map<string, PaymentInbox> {
  return new Map(hosts.map(host => [host, make(host)]))
}

export interface PollResult {
  accepted: number
  sats: number
  failed: Array<[host: string, error: string]>
}

/** Accept every waiting payment on every host. One host failing never stops the others. */
export async function pollInboxes(inboxes: Map<string, PaymentInbox>, log: (msg: string) => void = () => {}): Promise<PollResult> {
  const result: PollResult = { accepted: 0, sats: 0, failed: [] }
  for (const [host, inbox] of inboxes) {
    let payments
    try {
      payments = await inbox.listIncomingPayments()
    } catch (e: any) {
      result.failed.push([host, e?.message || String(e)])
      continue
    }
    for (const p of payments) {
      try {
        await inbox.acceptPayment(p)
        result.accepted++
        result.sats += Number(p.token?.amount ?? 0)
      } catch (e: any) {
        log(`[peck-mcp] ${host}: could not accept payment ${p.messageId}: ${e?.message || e}`)
      }
    }
  }
  return result
}
