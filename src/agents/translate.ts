/**
 * Translate agent — real translation via MyMemory API.
 * Free, no API key. ~5000 chars/day per IP for anonymous use.
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'translate-agent',
  walletName: 'translate',
  description: 'Real translation via MyMemory API (no API key)',
  pricePerCall: 500,
  capabilities: ['translate', 'detect-language'],
  port: 3001,
})

agent.handle('translate', async (req) => {
  const text = req.text
  if (!text) throw new Error('text required')
  const sourceLang = req.sourceLang || 'en'
  const targetLang = req.targetLang || 'no'

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`MyMemory HTTP ${r.status}`)
  const data = await r.json() as any
  if (data.responseStatus !== 200) {
    throw new Error(`MyMemory: ${data.responseDetails || 'unknown error'}`)
  }
  return {
    source_text: text,
    source_lang: sourceLang,
    target_lang: targetLang,
    translated_text: data.responseData.translatedText,
    confidence: data.responseData.match,
    source: 'mymemory.translated.net',
  }
})

agent.handle('detect-language', async (req) => {
  const text = req.text
  if (!text) throw new Error('text required')
  // Heuristic: check character distribution against known scripts.
  // Norwegian/Danish/Swedish have æøå/ÆØÅ (no), äö (sv), æø (da).
  // Tiny but real — no API call needed.
  const sample = text.slice(0, 500).toLowerCase()
  const norMarkers = (sample.match(/[æøå]/g) || []).length
  const sweMarkers = (sample.match(/[ä]/g) || []).length
  const totalLen = sample.length
  const detected =
    norMarkers / totalLen > 0.01 ? 'no' :
    sweMarkers / totalLen > 0.01 ? 'sv' :
    /[\u4e00-\u9fff]/.test(sample) ? 'zh' :
    /[а-яё]/i.test(sample) ? 'ru' :
    /[\u3040-\u30ff]/.test(sample) ? 'ja' :
    'en'
  return {
    text: text.slice(0, 100),
    detected_language: detected,
    confidence: 0.7,
    method: 'character-distribution-heuristic',
  }
})

agent.start()
