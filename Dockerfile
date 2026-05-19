# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev) for building
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy migration scripts for production use
COPY --from=builder --chown=node:node /app/src/scripts ./src/scripts
COPY --from=builder --chown=node:node /app/src/loader.js ./src/loader.js

# Set environment variables
ENV NODE_ENV=production

# Expose health check port
EXPOSE 3000

# Drop root privileges — run as the built-in node user (uid 1000)
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
