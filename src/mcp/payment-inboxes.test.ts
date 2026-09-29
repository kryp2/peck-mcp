import { describe, it, expect } from 'vitest'
import { EXTRA_PAYMENT_HOSTS, openInboxes, pollInboxes, type PaymentInbox } from './payment-inboxes.js'

function fakeInbox(payments: Array<{ messageId: string, token?: { amount?: number } }>, opts: { listFails?: string, acceptFails?: string[] } = {}) {
  const accepted: string[] = []
  const inbox: PaymentInbox & { accepted: string[] } = {
    accepted,
    listIncomingPayments: async () => {
      if (opts.listFails) throw new Error(opts.listFails)
      return payments
    },
    acceptPayment: async (p: any) => {
      if (opts.acceptFails?.includes(p.messageId)) throw new Error('internalize failed')
      accepted.push(p.messageId)
    },
  }
  return inbox
}

describe('payment inboxes', () => {
  it('covers the hosts BSV Desktop, BSV Browser and Peck OS send through', () => {
    expect(EXTRA_PAYMENT_HOSTS).toContain('https://gmb.bsvblockchain.tech')
    expect(EXTRA_PAYMENT_HOSTS).toContain('https://messagebox.babbage.systems')
    expect(EXTRA_PAYMENT_HOSTS).not.toContain('https://msg.peck.to') // bitcoin-agent-wallet already polls it
  })

  it('opens one client per host', () => {
    const made: string[] = []
    const inboxes = openInboxes({} as any, ['https://a', 'https://b'], host => { made.push(host); return fakeInbox([]) })
    expect(made).toEqual(['https://a', 'https://b'])
    expect([...inboxes.keys()]).toEqual(['https://a', 'https://b'])
  })

  it('accepts every payment on every host and sums the sats', async () => {
    const a = fakeInbox([{ messageId: '1', token: { amount: 1000 } }])
    const b = fakeInbox([{ messageId: '2', token: { amount: 2500 } }, { messageId: '3', token: { amount: 500 } }])
    const r = await pollInboxes(new Map([['https://a', a], ['https://b', b]]))
    expect(r).toEqual({ accepted: 3, sats: 4000, failed: [] })
    expect(a.accepted).toEqual(['1'])
    expect(b.accepted).toEqual(['2', '3'])
  })

  it('keeps going when one host is down', async () => {
    const down = fakeInbox([], { listFails: 'ECONNREFUSED' })
    const up = fakeInbox([{ messageId: '9', token: { amount: 700 } }])
    const r = await pollInboxes(new Map([['https://down', down], ['https://up', up]]))
    expect(r.accepted).toBe(1)
    expect(r.failed).toEqual([['https://down', 'ECONNREFUSED']])
  })

  it('logs a payment it cannot accept and carries on', async () => {
    const logs: string[] = []
    const inbox = fakeInbox([{ messageId: 'bad' }, { messageId: 'good', token: { amount: 100 } }], { acceptFails: ['bad'] })
    const r = await pollInboxes(new Map([['https://h', inbox]]), m => logs.push(m))
    expect(r).toEqual({ accepted: 1, sats: 100, failed: [] })
    expect(logs[0]).toContain('could not accept payment bad')
  })
})
