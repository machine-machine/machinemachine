# MachineMachine Landing Page
# Build stage
FROM node:20-alpine AS build

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy monorepo structure
COPY package.json pnpm-workspace.yaml ./
COPY packages/web/package.json packages/web/

# Install dependencies
RUN pnpm install --filter @machinemachine/web

# Copy source files
COPY packages/web/ packages/web/

# Build the Astro site
WORKDIR /app/packages/web
RUN pnpm build

# Production stage
FROM nginx:alpine

# Copy built static files
COPY --from=build /app/packages/web/dist /usr/share/nginx/html

# Simple nginx config for SPA with clean URLs
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ $uri.html /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

CMD ["nginx", "-g", "daemon off;"]
