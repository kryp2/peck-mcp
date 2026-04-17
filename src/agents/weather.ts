/**
 * Weather agent — real meteorological data from open-meteo.com
 *
 * Free, no API key, generous rate limit. Two capabilities:
 *   - get-weather: current conditions for a city
 *   - forecast:    7-day forecast for a city
 *
 * Geocoding via open-meteo's free geocoding API.
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'weather-agent',
  walletName: 'weather',
  description: 'Real weather data via open-meteo.com (no API key)',
  pricePerCall: 100,
  capabilities: ['get-weather', 'forecast'],
  port: 3002,
})

interface GeoHit { latitude: number; longitude: number; name: string; country: string }

async function geocode(location: string): Promise<GeoHit | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
  const r = await fetch(url)
  if (!r.ok) return null
  const data = await r.json() as { results?: GeoHit[] }
  return data.results?.[0] ?? null
}

agent.handle('get-weather', async (req) => {
  const location = req.location || 'Oslo'
  const geo = await geocode(location)
  if (!geo) throw new Error(`Could not geocode "${location}"`)

  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
  )
  const data = await r.json() as any
  const c = data.current
  return {
    location: `${geo.name}, ${geo.country}`,
    coordinates: { lat: geo.latitude, lon: geo.longitude },
    temperature_c: c.temperature_2m,
    humidity_pct: c.relative_humidity_2m,
    wind_kmh: c.wind_speed_10m,
    weather_code: c.weather_code,
    fetched_at: new Date().toISOString(),
    source: 'open-meteo.com',
  }
})

agent.handle('forecast', async (req) => {
  const location = req.location || 'Oslo'
  const days = Math.min(parseInt(req.days || '7', 10), 14)
  const geo = await geocode(location)
  if (!geo) throw new Error(`Could not geocode "${location}"`)

  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=${days}&timezone=auto`
  )
  const data = await r.json() as any
  const d = data.daily
  return {
    location: `${geo.name}, ${geo.country}`,
    forecast: d.time.map((date: string, i: number) => ({
      date,
      max_c: d.temperature_2m_max[i],
      min_c: d.temperature_2m_min[i],
      precip_mm: d.precipitation_sum[i],
      weather_code: d.weather_code[i],
    })),
    source: 'open-meteo.com',
  }
})

agent.start()
