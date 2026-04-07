import { ServiceAgent } from '../service-agent.js';

const agent = new ServiceAgent({
  name: "translate-agent",
  description: "Oversetter tekst mellom språk via LLM",
  pricePerCall: 500, // satoshis ($0.005/kall)
  capabilities: ["translate", "detect-language"],
});

agent.handle("translate", async (req) => {
  console.log(`Processing translation: "${req.text}" to ${req.targetLang}`);
  // Mock LLM translation delay
  await new Promise(resolve => setTimeout(resolve, 800));
  return { 
    translated: `[Translated to ${req.targetLang}]: ${req.text}` 
  };
});

agent.handle("detect-language", async (req) => {
  console.log(`Detecting language for: "${req.text}"`);
  await new Promise(resolve => setTimeout(resolve, 300));
  return { 
    language: "en",
    confidence: 0.98
  };
});

agent.start({ port: 3001 });
