/**
 * build-gap-file.ts — query peck_db for what's already posted, compute gaps
 * vs source bible JSON, write .gaps/<translation>.json.
 *
 * Output format: { "book-slug-lowercased": [[chapter, verse], ...], ... }
 *   Only verses missing from chain; scribes skip everything else.
 *
 * Connects to peck_db via local Cloud SQL Auth Proxy on 127.0.0.1:5433.
 *
 * Usage:
 *   PG_PASSWORD='...' npx tsx scripts/build-gap-file.ts <translation>
 *   e.g. npx tsx scripts/build-gap-file.ts no_1930
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import pg from 'pg'

const TRANS = process.argv[2]
if (!TRANS) { console.error('usage: build-gap-file.ts <translation>'); process.exit(1) }

const PG_HOST = process.env.PG_HOST || '127.0.0.1'
const PG_PORT = parseInt(process.env.PG_PORT || '5433', 10)
const PG_USER = process.env.PG_USER || 'peck_user'
const PG_PASSWORD = process.env.PG_PASSWORD
const PG_DB = process.env.PG_DB || 'peck_db'
if (!PG_PASSWORD) { console.error('PG_PASSWORD env required'); process.exit(1) }

async function main() {
  const dataPath = `.bible-data/${TRANS}.json`
  if (!existsSync(dataPath)) throw new Error(`bible data missing: ${dataPath}`)
  const rawStr = readFileSync(dataPath, 'utf-8').replace(/^\uFEFF/, '')
  const raw = JSON.parse(rawStr)
  const books = Array.isArray(raw) ? raw : Object.values(raw) as any[]

  const client = new pg.Client({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DB })
  await client.connect()
  console.log(`[gap] connected to ${PG_DB}; querying ${TRANS}…`)

  // Fetch all existing (book, chapter, verse) for this translation
  const q = `
    SELECT
      substring(tags FROM 'book:([^,]+)') AS book,
      CAST(substring(tags FROM 'chapter:([0-9]+)') AS INT) AS chapter,
      CAST(substring(tags FROM 'verse:([0-9]+)') AS INT) AS verse
    FROM pecks
    WHERE app = 'peck.cross'
      AND tags LIKE '%translation:' || $1 || '%'
      AND tags LIKE '%kind:verse%'
  `
  const result = await client.query(q, [TRANS])
  const existing = new Set<string>()
  for (const row of result.rows) {
    if (row.book && row.chapter && row.verse) {
      existing.add(`${row.book}:${row.chapter}:${row.verse}`)
    }
  }
  await client.end()
  console.log(`[gap] DB has ${existing.size} unique verses for ${TRANS}`)

  // Compute gaps from source
  const gaps: Record<string, [number, number][]> = {}
  let totalExpected = 0, totalMissing = 0
  for (let bi = 0; bi < books.length; bi++) {
    const book = books[bi]
    const slug = (book.name || book.abbrev || `book-${bi}`).toLowerCase().replace(/\s+/g, '-')
    gaps[slug] = []
    const chapters = book.chapters || []
    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci]
      const verses: string[] = Array.isArray(chapter) ? chapter : Object.values(chapter)
      for (let vi = 0; vi < verses.length; vi++) {
        totalExpected++
        const key = `${slug}:${ci + 1}:${vi + 1}`
        if (!existing.has(key)) {
          gaps[slug].push([ci + 1, vi + 1])
          totalMissing++
        }
      }
    }
    if (gaps[slug].length === 0) delete gaps[slug]
  }

  if (!existsSync('.gaps')) mkdirSync('.gaps')
  const outPath = `.gaps/${TRANS}.json`
  writeFileSync(outPath, JSON.stringify(gaps, null, 2))
  console.log(`\n[gap] ${TRANS}: expected=${totalExpected}  in_db=${existing.size}  missing=${totalMissing}  coverage=${(100 * (totalExpected - totalMissing) / totalExpected).toFixed(1)}%`)
  console.log(`[gap] books needing work: ${Object.keys(gaps).length} / ${books.length}`)
  console.log(`[gap] saved: ${outPath}`)
}

main().catch(e => { console.error('[gap] FAIL:', e.message || e); process.exit(1) })
