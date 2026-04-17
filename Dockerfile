FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --production=false

# Copy source
COPY src/ src/
COPY tsconfig.json ./
COPY .env* ./

# Cloud Run uses PORT env var (default 8080)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Start remote MCP server
CMD ["npx", "tsx", "src/mcp/peck-mcp-remote.ts"]
