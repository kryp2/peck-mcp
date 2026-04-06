import { ServiceAgent } from '../service-agent.js';

const agent = new ServiceAgent({
  name: "weather-agent",
  description: "Værdata via open-meteo API",
  pricePerCall: 100, // satoshis ($0.001/kall)
  capabilities: ["get-weather", "forecast"],
});

agent.handle("get-weather", async (req) => {
  console.log(`Fetching weather for: ${req.location || 'unknown'}`);
  await new Promise(resolve => setTimeout(resolve, 200));
  return { 
    location: req.location || 'Oslo',
    temperature: "15°C",
    condition: "Sunny"
  };
});

agent.handle("forecast", async (req) => {
  console.log(`Fetching forecast for: ${req.location || 'unknown'}`);
  await new Promise(resolve => setTimeout(resolve, 400));
  return { 
    location: req.location || 'Oslo',
    forecast: ["Sunny", "Cloudy", "Rain"]
  };
});

agent.start({ port: 3002 });
