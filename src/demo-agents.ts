import { PrivateKey } from '@bsv/sdk'
import { createServer, IncomingMessage, ServerResponse } from 'http'

// Make WebSocket available in older Node versions via global fetch if not defined
const WS = typeof WebSocket !== 'undefined' ? WebSocket : class DummyWS {
  readyState = 0;
  onopen = () => {};
  onerror = () => {};
  constructor(url: string) { setTimeout(() => { this.readyState = 1; this.onopen(); }, 100); }
  send(data: string) { /* no-op */ }
};

async function fetchGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return `[Simulated AI Response for: ${prompt.substring(0, 50)}...] (Provide GEMINI_API_KEY for real AI)`;
  
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200 },
        }),
      }
    )
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response';
  } catch (err) {
    return `[AI Error]: ${String(err)}`;
  }
}

export abstract class ServiceAgent {
  public identityKey: PrivateKey;
  public dashboardWs: typeof WS.prototype | null = null;
  public config: any;

  constructor(public name: string, public price: number, public port: number) {
    this.identityKey = PrivateKey.fromRandom(); // Own BSV wallet / BRC-103 identity
    this.config = { name, price, port, address: this.identityKey.toAddress() };
  }

  async start() {
    this.registerBrc103();
    this.connectDashboard();
    
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Handle CORS
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(200);
        res.end();
        return;
      }
      
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.config));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            this.logActivity(`Received request`, parsed);
            
            const result = await this.handleRequest(parsed);
            
            this.logActivity(`Completed request`, result);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            this.logActivity(`Error`, String(e));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(this.port, () => {
      console.log(`[${this.name}] Started on http://localhost:${this.port} | Identity: ${this.identityKey.toAddress()} | Price: $${this.price}/call`);
    });
  }

  registerBrc103() {
    console.log(`[${this.name}] Registering BRC-103 identity on overlay...`);
    this.logActivity('BRC-103 Registration', {
      pubkey: this.identityKey.toPublicKey().toString(),
      address: this.identityKey.toAddress(),
      service: this.name,
      price: this.price
    });
  }

  connectDashboard() {
    try {
      this.dashboardWs = new WS('ws://localhost:8080/dashboard') as typeof WS.prototype;
      this.dashboardWs.onopen = () => console.log(`[${this.name}] Connected to dashboard WS`);
      this.dashboardWs.onerror = () => {}; // Ignore errors for demo
    } catch(e) {
      console.log(`[${this.name}] Failed to connect to websocket dashboard: ${e}`);
    }
  }

  logActivity(action: string, data: any) {
    const log = { agent: this.name, address: this.identityKey.toAddress(), action, data, timestamp: Date.now() };
    if (this.dashboardWs && this.dashboardWs.readyState === 1) {
      try {
        this.dashboardWs.send(JSON.stringify(log));
      } catch (e) { /* ignore ws send errors */ }
    }
  }

  abstract handleRequest(data: any): Promise<any>;
}

// 1. Translate Agent ($0.005/kall)
export class TranslateAgent extends ServiceAgent {
  constructor() { super('Translate Agent', 0.005, 4001); }
  
  async handleRequest({ text, targetLang }: any) {
    const prompt = `Translate the following text to ${targetLang}. Only output the translation. Text: ${text}`;
    const translated = await fetchGemini(prompt);
    
    return {
      translated: translated.trim(),
      detectedLang: 'auto',
      confidence: 0.95
    };
  }
}

// 2. Weather Agent ($0.001/kall)
export class WeatherAgent extends ServiceAgent {
  constructor() { super('Weather Agent', 0.001, 4002); }
  
  async handleRequest({ lat, lon, city }: any) {
    let latitude = lat;
    let longitude = lon;
    
    // Very basic city geocoding stub
    if (!latitude || !longitude) {
      const coords: Record<string, {lat: number, lon: number}> = {
        'Oslo': { lat: 59.91, lon: 10.75 },
        'London': { lat: 51.5, lon: -0.1 },
        'New York': { lat: 40.71, lon: -74.00 }
      };
      const c = coords[city] || { lat: 0, lon: 0 };
      latitude = c.lat;
      longitude = c.lon;
    }

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&hourly=relative_humidity_2m`;
      const res = await fetch(url);
      const data = await res.json() as any;
      
      return { 
        temp: data?.current_weather?.temperature || 0,
        humidity: data?.hourly?.relative_humidity_2m?.[0] || 50,
        description: 'Clear', // simplified
        forecast_24h: 'Sunny/Clear expected' // simplified
      };
    } catch (e) {
      return { error: 'Failed to fetch weather', details: String(e) };
    }
  }
}

// 3. Summarize Agent ($0.01/kall)
export class SummarizeAgent extends ServiceAgent {
  constructor() { super('Summarize Agent', 0.01, 4003); }
  
  async handleRequest({ url }: any) {
    const prompt = `Extract the main points and summarize the content found at this URL: ${url}. Provide a concise summary and a few key points.`;
    const summaryText = await fetchGemini(prompt);
    
    return {
      summary: summaryText.trim(),
      key_points: ['Summary extracted from LLM', 'External URL parsing simulated'],
      word_count: summaryText.split(/\s+/).length
    };
  }
}

// 4. Price Oracle Agent ($0.002/kall)
export class PriceOracleAgent extends ServiceAgent {
  constructor() { super('Price Oracle Agent', 0.002, 4004); }
  
  async handleRequest({ asset }: any) {
    const map: Record<string, string> = { 
      'BSV': 'bitcoin-cash-sv', 
      'BTC': 'bitcoin', 
      'ETH': 'ethereum',
      'NOK': 'nok' // coingecko doesn't do fiat vs fiat this way, but stubbing for demo
    };
    
    const id = map[asset?.toUpperCase()] || asset?.toLowerCase();
    
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`);
      const data = await res.json() as any;
      
      const priceData = data[id];
      if (!priceData) throw new Error('Asset not found');
      
      return { 
        price_usd: priceData.usd,
        change_24h: priceData.usd_24h_change || 0,
        timestamp: Date.now() 
      };
    } catch (e) {
      // Fallback for demo
      return {
        price_usd: asset === 'BSV' ? 65.42 : 0,
        change_24h: 1.5,
        timestamp: Date.now(),
        note: 'Fallback data'
      };
    }
  }
}

// 5. File Convert Agent ($0.005/kall)
export class FileConvertAgent extends ServiceAgent {
  constructor() { super('File Convert Agent', 0.005, 4005); }
  
  async handleRequest({ data_base64, from_format, to_format }: any) {
    const decoded = Buffer.from(data_base64, 'base64').toString('utf-8');
    let converted = decoded;
    
    if (from_format === 'json' && to_format === 'csv') {
      try {
        const obj = JSON.parse(decoded);
        const arr = Array.isArray(obj) ? obj : [obj];
        if (arr.length > 0) {
          const keys = Object.keys(arr[0]);
          converted = keys.join(',') + '\n' + arr.map(o => keys.map(k => o[k] ?? '').join(',')).join('\n');
        }
      } catch (e) {
        converted = `[Error converting JSON to CSV: ${String(e)}]`;
      }
    } else if (from_format === 'markdown' && to_format === 'html') {
      // Very naive markdown conversion
      converted = decoded
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
        .replace(/\n$/gim, '<br />');
    } else {
      converted = `[Simulated conversion from ${from_format} to ${to_format}]\n${decoded}`;
    }
    
    return {
      converted_base64: Buffer.from(converted).toString('base64'),
      format: to_format
    };
  }
}

// Boot all agents if run directly
if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1].endsWith('demo-agents.ts')) {
  console.log('='.repeat(60));
  console.log('  Agentic Pay — Starting Demo Service Agents');
  console.log('='.repeat(60));
  
  const agents = [
    new TranslateAgent(),
    new WeatherAgent(),
    new SummarizeAgent(),
    new PriceOracleAgent(),
    new FileConvertAgent()
  ];
  
  for (const agent of agents) {
    agent.start();
  }
}
