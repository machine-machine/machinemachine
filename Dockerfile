# MachineMachine Landing Page
# Single-stage static build

FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy everything
COPY . .

# Install dependencies at root (monorepo)
RUN pnpm install

# Build the web package
RUN cd packages/web && pnpm build

# Production - serve static files with nginx
FROM nginx:alpine

# Copy built static files
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# Simple nginx config
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
