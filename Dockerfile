# 🐳 Multi-stage Dockerfile for Flexus Solana Bot
# Stage 1: Build the TypeScript codebase
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy source code and build
COPY . .
RUN npm run build

# Stage 2: Runtime image (minimal)
FROM node:20-slim

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies only
RUN npm install --omit=dev --legacy-peer-deps

# Environmental Variables are handled by Google Cloud Console or Secrets Manager
# But we ensure the bot starts in production mode
ENV NODE_ENV=production

# Start the bot
CMD ["node", "dist/index.js"]
