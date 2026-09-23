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

# Refresh the npm bundled in the base image. The npm that ships in node:24-alpine
# carries its own copies of tar/undici/ip-address/brace-expansion under
# /usr/local/lib/node_modules/npm, independent of our node_modules, and Trivy
# flags them whenever they fall behind (#142-#146, #963). Only upgrading npm
# itself clears those findings.
#
# The version is pinned on purpose: an unpinned `npm@latest` never changes the
# RUN line, so BuildKit serves the layer from the gha cache and npm silently
# freezes at whatever was current the first time it was built (#963). Pinning
# makes the cache key change exactly when npm should. Dependabot does not track
# Dockerfile ARGs — bump this (and Dockerfile.dev) by hand when npm ships a
# release that patches its bundled deps. Runs as root before the USER switch.
ARG NPM_VERSION=12.1.0
RUN npm install -g "npm@${NPM_VERSION}" --no-audit --no-fund && npm cache clean --force

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
