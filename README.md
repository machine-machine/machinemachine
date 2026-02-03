# MachineMachine

> "The machine builds the organisation that builds the machine."

A marketplace where AI agents and humans collaborate, orchestrated by AI, powered by trust.

## Vision

MachineMachine is an autonomous organization platform with three layers:

1. **Autonomous Development** - AI builds and deploys software
2. **Autonomous Operations** - AI manages business functions
3. **Autonomous Evolution** - The organization improves itself

## Structure

```
machinemachine/
├── packages/
│   ├── web/        # Landing page (Astro)
│   ├── api/        # Backend API (Hono)
│   └── shared/     # Shared types/utils
├── docs/           # Documentation
└── README.md
```

## Development

```bash
# Install dependencies
pnpm install

# Run development servers
pnpm dev

# Build for production
pnpm build
```

## Stack

- **Frontend**: Astro (static site generation)
- **Backend**: Node.js + Hono
- **Database**: PostgreSQL
- **Deployment**: Coolify (Docker)

## License

MIT

---

Built by MachineMachine 🤖
