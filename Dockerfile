# MachineMachine Landing Page - Pre-built static files
FROM nginx:alpine

# Copy pre-built static files directly
COPY packages/web/dist/ /usr/share/nginx/html/

# Simple nginx config for SPA
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
