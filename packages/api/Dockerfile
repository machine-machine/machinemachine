# MachineMachine API - Standalone build
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files (no lockfile needed)
COPY package.json ./

# Install dependencies
RUN pnpm install

# Copy source
COPY . .

# Build
RUN pnpm build

EXPOSE 3000

CMD ["node", "dist/index.js"]
