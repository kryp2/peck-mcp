/**
 * Summarize agent — real URL/text content extraction + summary.
 *
 * Uses Jina Reader (https://r.jina.ai/) for URL → clean markdown.
 * Free, no API key. Summarization is extractive (top sentences by
 * word frequency); upgrades to Gemini if GEMINI_API_KEY is set.
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'summarize-agent',
  walletName: 'summarize',
  description: 'Real URL/text summarization via Jina Reader + extractive (or Gemini if key set)',
  pricePerCall: 1000,
  capabilities: ['summarize-url', 'summarize-text'],
  port: 3003,
})

async function fetchUrlAsMarkdown(url: string): Promise<string> {
  const r = await fetch(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'markdown' } })
  if (!r.ok) throw new Error(`Jina Reader HTTP ${r.status}`)
  return await r.text()
}

async function summarizeWithGemini(text: string, apiKey: string): Promise<string> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Summarize the following in 3-5 sentences:\n\n${text.slice(0, 10000)}` }] }],
        generationConfig: { maxOutputTokens: 300 },
      }),
    }
  )
  const data = await r.json() as any
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

function extractiveSummary(text: string, maxSentences = 4): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned]
  if (sentences.length <= maxSentences) return cleaned
  const stopwords = new Set('the a an and or but is are was were of in on at to for with by as it this that be have has had not no'.split(' '))
  const freq = new Map<string, number>()
  for (const s of sentences) {
    for (const w of s.toLowerCase().match(/[a-z]{3,}/g) || []) {
      if (stopwords.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().match(/[a-z]{3,}/g) || []
    const score = words.reduce((acc, w) => acc + (freq.get(w) || 0), 0) / Math.max(words.length, 1)
    return { i, s: s.trim(), score }
  })
  const top = scored.sort((a, b) => b.score - a.score).slice(0, maxSentences)
  top.sort((a, b) => a.i - b.i)
  return top.map(t => t.s).join(' ')
}

async function summarize(text: string): Promise<{ summary: string; method: string }> {
  const geminiKey = process.env.GEMINI_API_KEY
  if (geminiKey && text.length > 200) {
    try {
      const llmSummary = await summarizeWithGemini(text, geminiKey)
      if (llmSummary) return { summary: llmSummary, method: 'gemini-2.0-flash' }
    } catch (e) {
      console.warn('Gemini failed, falling back to extractive:', e)
    }
  }
  return { summary: extractiveSummary(text), method: 'extractive' }
}

agent.handle('summarize-url', async (req) => {
  if (!req.url) throw new Error('url required')
  const markdown = await fetchUrlAsMarkdown(req.url)
  const { summary, method } = await summarize(markdown)
  return {
    url: req.url,
    summary,
    summarization_method: method,
    extracted_chars: markdown.length,
    source: 'r.jina.ai',
  }
})

agent.handle('summarize-text', async (req) => {
  if (!req.text) throw new Error('text required')
  const { summary, method } = await summarize(req.text)
  return {
    summary,
    summarization_method: method,
    input_chars: req.text.length,
  }
})

agent.start()
