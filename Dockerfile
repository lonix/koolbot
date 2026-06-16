# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev) for building
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production dependencies stage
FROM node:24-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

# Production stage
FROM node:24-alpine

WORKDIR /app

# Stopgap: pull patched OpenSSL libraries ahead of the base image so Trivy's
# system-package scan stays clean whenever the Alpine base lags upstream
# OpenSSL fixes (historically flagged against libssl3/libcrypto3 — High
# #57/#72, Medium #590, Low #62-#71/#77-#86 on node:22-alpine). Runs as root
# before dropping to USER node. Drop once Trivy confirms node:24-alpine ships
# the fixed libssl3/libcrypto3 (tracked in #604).
RUN apk --no-cache upgrade libssl3 libcrypto3

# Copy only runtime artifacts
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# Set environment variables
ENV NODE_ENV=production

# Expose health check port
EXPOSE 3000

# Drop root privileges — run as the built-in node user (uid 1000)
USER node

# Health check — uses the readiness endpoint (/ready, gated on Discord +
# MongoDB). Kubernetes deployments should point a livenessProbe at /live
# (always 200 once listening) and a readinessProbe at /ready.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ready || exit 1

# Start the application
CMD ["npm", "start"]
