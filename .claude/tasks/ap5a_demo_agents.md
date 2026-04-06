---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap4a_marketplace_webapp]
verify: true
test_cmd: null
---

# AP5A: Demo Service Agents

## Mål
Bygg 5+ service-agenter som kjører på markedsplassen under demo.
Disse viser bredden av hva plattformen kan gjøre.

## Agenter

### 1. Translate Agent ($0.005/kall)
- Input: { text, targetLang }
- Bruker LLM (Gemini free tier) for oversettelse
- Output: { translated, detectedLang, confidence }

### 2. Weather Agent ($0.001/kall)
- Input: { lat, lon } eller { city }
- Bruker Open-Meteo API (gratis, ingen key)
- Output: { temp, humidity, description, forecast_24h }

### 3. Summarize Agent ($0.01/kall)
- Input: { url }
- Henter innhold, oppsummerer via LLM
- Output: { summary, key_points[], word_count }

### 4. Price Oracle Agent ($0.002/kall)
- Input: { asset } (BSV, BTC, ETH, NOK)
- Henter pris fra CoinGecko/ekstern API
- Output: { price_usd, change_24h, timestamp }

### 5. File Convert Agent ($0.005/kall)
- Input: { data_base64, from_format, to_format }
- Støtter: JSON↔CSV, Markdown→HTML, etc
- Output: { converted_base64, format }

## Alle agenter
- Registrerer seg på BRC-103 overlay ved oppstart
- Har egen BSV-wallet med BRC-103 identity
- Logger all aktivitet til dashboard via WebSocket
