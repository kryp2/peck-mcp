#!/usr/bin/env npx tsx
/**
 * fleet_spawn.ts — launch all 25 curator fleet_loop processes in parallel.
 * Aggregates TPS across the fleet at the end.
 *
 * Usage:
 *   npx tsx src/fleet_spawn.ts [duration_sec=300]
 */
import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DURATION = parseInt(process.argv[2] || '300', 10)

const AGENTS = [
  'curator-tech', 'curator-news', 'curator-art', 'curator-finance', 'curator-meta',
  'curator-history', 'curator-research', 'curator-signal', 'curator-archive', 'curator-bridge',
  'curator-quant', 'curator-ethno', 'curator-narrative', 'curator-prose', 'curator-dev',
  'curator-sovereign', 'curator-long', 'curator-short', 'curator-memory', 'curator-debate',
  'curator-calm', 'curator-edge', 'curator-core', 'curator-drift', 'curator-witness',
]

async function main() {
  console.log(`[fleet] spawning ${AGENTS.length} curators for ${DURATION}s each`)
  const startTs = Date.now()

  const children = AGENTS.map(a => {
    const proc = spawn('npx', ['tsx', resolve(__dirname, 'fleet_loop.ts'), a, String(DURATION)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n').filter(Boolean)
      for (const l of lines) if (l.startsWith('[fleet]')) process.stdout.write(`[${a.padEnd(18)}] ${l}\n`)
    })
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim()
      if (s && !s.includes('generateChangeSdk') && !s.includes('injected env')) {
        process.stderr.write(`[${a.padEnd(18)}] ${s.slice(0, 200)}\n`)
      }
    })
    return new Promise<void>(r => proc.on('close', () => r()))
  })

  await Promise.all(children)
  const elapsed = (Date.now() - startTs) / 1000

  let totalOk = 0, totalFail = 0
  const perAgent: string[] = []
  for (const a of AGENTS) {
    const path = `/tmp/fleet_${a}_summary.json`
    if (!existsSync(path)) { perAgent.push(`  ${a.padEnd(20)} NO SUMMARY`); continue }
    const s = JSON.parse(readFileSync(path, 'utf-8'))
    totalOk += s.succeeded || 0; totalFail += s.failed || 0
    perAgent.push(`  ${a.padEnd(20)} ok=${String(s.succeeded).padStart(4)} fail=${String(s.failed).padStart(4)} tps=${(s.tps_sustained || 0).toFixed(2)}`)
  }
  const tps = totalOk / elapsed
  console.log('\n=== FLEET RESULT ===')
  for (const line of perAgent) console.log(line)
  console.log(`\n  TOTAL ok=${totalOk} fail=${totalFail} elapsed=${elapsed.toFixed(0)}s combined_tps=${tps.toFixed(2)}`)
  console.log(`  extrapolated 24h: ${Math.round(tps * 86400).toLocaleString()} TX`)
  console.log(`  progress toward 1.5M goal: ${(100 * tps * 86400 / 1_500_000).toFixed(1)}%`)
}

main().catch(e => { console.error('[fleet] FATAL', e); process.exit(1) })
