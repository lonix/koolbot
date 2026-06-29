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

# Refresh the npm bundled in the base image. node:24-alpine ships an npm whose
# bundled undici/tar carry known advisories (Trivy #142-#146); upgrading to the
# latest npm pulls in patched tar (>= 7.5.16) and undici. These live under
# /usr/local/lib/node_modules/npm and are independent of our own node_modules,
# so only refreshing npm clears them. Runs as root before the USER switch below.
# hadolint ignore=DL3016
RUN npm install -g npm@latest --no-audit --no-fund && npm cache clean --force

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
