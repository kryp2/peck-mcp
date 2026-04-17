/**
 * Geocoding agent — real place lookups + reverse geocoding via open-meteo.
 * Free, no API key.
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'geocode-agent',
  walletName: 'geocode',
  description: 'Geocode places to coordinates via open-meteo (no API key)',
  pricePerCall: 50,
  capabilities: ['geocode', 'reverse-geocode'],
  port: 3005,
})

agent.handle('geocode', async (req) => {
  if (!req.location) throw new Error('location required')
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(req.location)}&count=${req.limit || 5}`
  )
  if (!r.ok) throw new Error(`open-meteo HTTP ${r.status}`)
  const data = await r.json() as { results?: any[] }
  return {
    query: req.location,
    results: (data.results || []).map((r: any) => ({
      name: r.name,
      country: r.country,
      admin1: r.admin1,
      latitude: r.latitude,
      longitude: r.longitude,
      population: r.population,
      timezone: r.timezone,
    })),
    source: 'open-meteo.com',
  }
})

agent.handle('reverse-geocode', async (req) => {
  if (req.lat === undefined || req.lon === undefined) {
    throw new Error('lat and lon required')
  }
  // Use Nominatim (OSM) for reverse geocoding — free, requires UA, polite use only
  const r = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${req.lat}&lon=${req.lon}&zoom=10`,
    { headers: { 'User-Agent': 'PeckPayHackathonDemo/0.1 (educational)' } }
  )
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`)
  const data = await r.json() as any
  return {
    coordinates: { lat: req.lat, lon: req.lon },
    address: data.display_name,
    components: data.address,
    source: 'nominatim.openstreetmap.org',
  }
})

agent.start()
