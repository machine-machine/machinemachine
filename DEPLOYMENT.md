# MachineMachine Deployment Guide

## GitHub Repository
- **URL**: https://github.com/machine-machine/machinemachine
- **Branch**: main
- **Auto-rebuild**: Coolify webhook on push

## Coolify Deployment

### 1. Create PostgreSQL Database

In Coolify (cool.machinemachine.ai):
1. Go to Project: machine.machine → production
2. New → Database → PostgreSQL
3. Settings:
   - Name: `machinemachine-db`
   - Version: 16
4. Create & start

Save the connection string for the API.

### 2. Deploy Landing Page (Web)

1. Go to Project: machine.machine → production
2. New → Application
3. Source: GitHub → machine-machine/machinemachine
4. Build pack: Dockerfile
5. Settings:
   - Name: `machinemachine-web`
   - Dockerfile location: `packages/web/Dockerfile`
   - Base directory: `packages/web`
   - Domain: `machine.machine` or `machinemachine.ai`
6. Deploy

### 3. Deploy API

1. Go to Project: machine.machine → production
2. New → Application
3. Source: GitHub → machine-machine/machinemachine
4. Build pack: Dockerfile
5. Settings:
   - Name: `machinemachine-api`
   - Dockerfile location: `packages/api/Dockerfile`
   - Base directory: `packages/api`
   - Domain: `api.machine.machine` or `api.machinemachine.ai`
6. Environment variables:
   ```
   DATABASE_URL=postgresql://user:pass@machinemachine-db:5432/machinemachine
   PORT=3000
   NODE_ENV=production
   ```
7. Deploy

## Local Development

```bash
# Install dependencies
cd ~/.openclaw/workspace/machinemachine
pnpm install

# Run web (landing page)
cd packages/web
pnpm dev
# → http://localhost:4321

# Run API
cd packages/api  
pnpm dev
# → http://localhost:3000
```

## Domain Configuration

Ensure these DNS records exist:
- `machine.machine` → Coolify server IP
- `api.machine.machine` → Coolify server IP
- Or use `*.machinemachine.ai` wildcard

## Webhook Setup

Coolify auto-creates webhooks. Verify in GitHub:
1. Repo Settings → Webhooks
2. Should see `https://cool.machinemachine.ai/webhooks/...`

---

*Deployment guide generated 2026-02-03*
