# Hosted read-only MCP server (what runs at https://mcp.peck.to): landing page,
# /mcp (StreamableHTTP) and /llms.txt from one process. It loads no wallet and
# holds no keys; write tools only answer with an install hint.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY src/ src/
COPY tsconfig.json ./
COPY static/ static/
# .env is deliberately NOT copied: the hosted server is read-only and holds no keys.

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

CMD ["npx", "tsx", "src/mcp/peck-mcp-remote.ts"]
