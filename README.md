# RESCORA

RESCORA is a safety-first Burrow position assessment product for NEAR. This repository contains the **Phase 1 application foundation only**. The current shell does not connect a wallet, query Burrow, calculate risk, call an AI provider, store spending limits, construct transactions, or submit transactions.

The network chip identifies the product's configured target scope (NEAR testnet); it does not indicate an active wallet or chain connection. No account or financial data displayed by this Phase 1 shell is live.

## Requirements

- Node.js 22.9 or later (the Next.js framework requires Node 20.9+, and the environment validation command uses Node's `--env-file-if-exists` option).
- pnpm 11.25.0 (pinned in `package.json`).

## Setup

From `rescora-app/`:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. `.env.local` contains only the product network-scope setting; do not put secrets or keys in it. `.env.example` is safe to commit.

## Environment

| Variable          | Required value | Purpose                                                                                                                                      |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESCORA_NETWORK` | `near-testnet` | Locks the Phase 1 application configuration to NEAR testnet product scope. This is not a live network connection. Other values are rejected. |

The same validator is used by the pre-start/pre-build check and `/api/health`. The health route reports unconfigured wallet, Burrow and AI integrations, and disabled execution.

## Commands

```powershell
pnpm dev          # Validate environment and start Next.js
pnpm build        # Validate environment and create a production build
pnpm start        # Validate environment and start the production server
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
pnpm test         # Run unit/component tests once
pnpm test:watch   # Run tests in watch mode
pnpm format:check # Check formatting
pnpm format       # Format supported project files
pnpm check:env    # Validate required environment configuration
```

## Phase 1 boundary

Implemented: responsive RESCORA shell, navigation routes, approved Quiet signal tokens, reusable UI primitives, environment validation, a minimal health endpoint, not-found/error states, and basic tests.

Not implemented: wallet connection, Burrow RPC, risk calculations, AI, spending controls, repayment calculations, transaction construction, OutLayer, execution, database, or mainnet functionality. These belong to later phases and require their documented verification/approval gates.
