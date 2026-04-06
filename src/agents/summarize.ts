import { ServiceAgent } from '../service-agent.js';

const agent = new ServiceAgent({
  name: "summarize-agent",
  description: "URL-oppsummering via LLM",
  pricePerCall: 1000, // satoshis ($0.01/kall)
  capabilities: ["summarize-url", "summarize-text"],
});

agent.handle("summarize-url", async (req) => {
  console.log(`Summarizing URL: ${req.url}`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  return { 
    url: req.url,
    summary: "This is a brief summary of the content found at the provided URL. It discusses various interesting topics."
  };
});

agent.handle("summarize-text", async (req) => {
  console.log(`Summarizing text of length: ${req.text?.length || 0}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  return { 
    summary: "Brief summary of the provided text."
  };
});

agent.start({ port: 3003 });
