/**
 * Metering & Billing service agent.
 *
 * Exposes the in-process metering engine over HTTP so other agents,
 * dashboards, and auditors can query usage and trigger anchoring.
 *
 * Capabilities:
 *   - record:   append a usage event (called by services after each request)
 *   - recent:   list recent events (for dashboards)
 *   - anchor:   compute merkle root over un-anchored events; caller broadcasts
 *   - verify:   re-compute root for a range and check it matches an anchor
 */
import { BrcServiceAgent } from '../brc-service-agent.js'
import { metering } from '../metering.js'

const agent = new BrcServiceAgent({
  name: 'metering-agent',
  walletName: 'metering',
  description: 'Tamper-proof usage metering with periodic Merkle anchoring on BSV',
  pricePerCall: 10,
  capabilities: ['record', 'recent', 'anchor', 'verify', 'stats', 'totals'],
  port: 3013,
})

agent.handle('record', async (req) => {
  if (!req.service || !req.capability || req.amount_sat == null) {
    throw new Error('service, capability, amount_sat required')
  }
  const event = metering.record({
    service: req.service,
    capability: req.capability,
    caller: req.caller || 'anonymous',
    amount_sat: req.amount_sat,
    request_hash: req.request_hash || '',
    response_hash: req.response_hash || '',
  })
  return { recorded: event }
})

agent.handle('recent', async (req) => {
  return { events: metering.recent(req.limit || 20) }
})

agent.handle('anchor', async () => {
  const anchor = metering.prepareAnchor()
  if (!anchor) return { error: 'nothing to anchor', stats: metering.stats() }
  return {
    anchor,
    note: 'broadcast this root to BSV via OP_RETURN, then call /verify with txid',
  }
})

agent.handle('verify', async (req) => {
  if (req.eventId == null || req.anchorIdx == null) {
    throw new Error('eventId and anchorIdx required')
  }
  const ok = metering.verifyEventInAnchor(req.eventId, req.anchorIdx)
  return { ok, eventId: req.eventId, anchorIdx: req.anchorIdx }
})

agent.handle('stats', async () => metering.stats())

agent.handle('totals', async (req) => {
  if (req.caller) return { caller: req.caller, total_spent_sat: metering.totalSpentBy(req.caller) }
  if (req.service) return { service: req.service, total_earned_sat: metering.totalEarnedBy(req.service) }
  throw new Error('caller or service required')
})

agent.start()
