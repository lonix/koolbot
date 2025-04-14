FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --include=dev

COPY . .

# Create dist directory and compile TypeScript with verbose output
RUN mkdir -p dist && \
    npm run build --verbose && \
    echo "Contents of dist directory:" && \
    ls -la dist/

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["npm", "start"]
