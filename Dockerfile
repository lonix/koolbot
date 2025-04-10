FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Create dist directory and compile TypeScript
RUN mkdir -p dist && npm run build

CMD ["npm", "start"]
