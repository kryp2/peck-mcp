import { describe, it, expect } from 'vitest'
import { PROOF_TASK, monitorOf, syncProofs, type ProofSyncMonitor } from './proof-sync.js'

function fakeMonitor(height = 968_753) {
  const ran: string[] = []
  const m: ProofSyncMonitor & { ran: string[] } = {
    ran,
    services: { getHeight: async () => height },
    runTask: async (name: string) => {
      ran.push(name)
      return `ran ${name} at ${(m.lastNewHeader as any)?.height}`
    },
  }
  return m
}

describe('monitorOf', () => {
  it('finds the toolbox Monitor behind a BitcoinAgentWallet', () => {
    const monitor = fakeMonitor()
    expect(monitorOf({ setup: { monitor } })).toBe(monitor)
  })

  it('returns null when the wallet layout does not expose a usable Monitor', () => {
    expect(monitorOf(null)).toBeNull()
    expect(monitorOf({})).toBeNull()
    expect(monitorOf({ setup: {} })).toBeNull()
    expect(monitorOf({ setup: { monitor: { runTask: async () => '' } } })).toBeNull()
  })
})

describe('syncProofs', () => {
  it('runs only CheckForProofs — never TaskSendWaiting or other Monitor tasks', async () => {
    const monitor = fakeMonitor()
    await syncProofs(monitor)
    expect(monitor.ran).toEqual([PROOF_TASK])
    expect(PROOF_TASK).toBe('CheckForProofs')
  })

  it('sets lastNewHeader to the current height first, without which the task is a no-op', async () => {
    const monitor = fakeMonitor(123)
    const log = await syncProofs(monitor)
    expect(monitor.lastNewHeader).toEqual({ height: 123 })
    expect(log).toBe('ran CheckForProofs at 123')
  })
})
