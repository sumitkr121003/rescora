# RESCORA

RESCORA is a NEAR hackathon prototype for making lending-position risk easier to inspect before considering a rescue repayment. It provides a wallet-free synthetic demo and a separate experimental, read-only Burrow Testnet assessment path. It does not sign or submit repayment transactions.

## How the product works

1. **Explore Demo** loads the shared synthetic fixture without connecting a wallet or making RPC requests.
2. The position overview shows illustrative collateral, debt, fixed prices, and a demo repayment balance.
3. Deterministic code calculates the fixture health factor and two repayment candidates. Candidate values are capped by both debt and the synthetic repay balance.
4. Groq may explain the risk and select only one of the existing candidate IDs. If Groq is not configured or its request/response fails, the browser displays a deterministic local explanation instead.
5. Selecting a candidate opens a review-only plan with its exact fixture units. There is no approval, signing, submission, transaction hash, or success state.
6. **Live connection** switches to a separate Testnet read-only view. It never fills failed or unavailable live data with fixture data.

## Demo assumptions

The demo position contains 2,000 NEAR collateral priced at $4, 6,500 USDC debt priced at $1, and 3,000 synthetic USDC available for repayment. Its illustrative health factor is:

```text
(2,000 × $4 × 0.75) ÷ (6,500 × $1) ≈ 0.92
```

The 0.75 collateral factor and 1.00 risk boundary are demo assumptions, not verified Burrow protocol parameters. The candidate amounts are preset at 1,000 and 2,000 USDC, capped against fixture debt and repayment funds, and ordered from smaller to larger. All demo values are synthetic and do not belong to a connected wallet or a Burrow snapshot.

## NEAR and Burrow integration

The app uses NEAR Wallet Selector with the Meteor Wallet module for explicit wallet connection. The wallet layer reads the selected account/key pair and attempts Testnet identity verification. Demo mode is independent of wallet state.

The Live connection path can request read-only Burrow Testnet views through the app's RPC proxy and evidence pipeline. Live Burrow reads are currently blocked by RPC transport failures in the target environment. In addition, deployed contract equivalence, response completeness, token units, oracle authenticity, and risk mechanics have not passed validation. The UI therefore does not display unverified live balances as an assessment and does not generate live repayment recommendations. No live repayment execution is implemented.

The deterministic risk module reproduces the available RHEA SDK weighted collateral/debt formula using explicit balances, decimal scales, prices, and volatility ratios. It uses exact integer rational arithmetic, preserves the SDK ratio cap, and returns an unverified model result without assigning an authoritative liquidation classification. Missing or invalid values fail closed. This model has not been matched to the deployed Burrow Testnet contract.

## Groq's restricted role

Groq is optional and used only for the synthetic demo. Its server route receives the fixture and deterministic candidates, requests schema-constrained JSON, and validates the recommendation against the supplied candidate IDs and bounded qualitative text. The response schema contains no repayment amount field. The AI cannot create or edit financial values, access wallet data, call RPC, approve transactions, or execute transactions. Missing credentials, timeout, provider errors, and invalid responses do not block the demo; a deterministic fallback is used.

## Local setup

Requirements: Node.js 22.9 or newer and Corepack.

From this directory:

```powershell
corepack pnpm install --frozen-lockfile
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
corepack pnpm dev
```

Open `http://localhost:3000`. The home page starts in demo mode; no wallet or Groq key is needed. The Meteor wallet is only needed to try the separate wallet connection and live read path.

## Environment variables

| Variable          | Required | Purpose                                                                 |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `RESCORA_NETWORK` | Yes      | Must be `near-testnet`; sets the app's declared network scope.          |
| `GROQ_API_KEY`    | No       | Server-only credential for the optional synthetic demo explanation.     |
| `GROQ_MODEL`      | No       | Optional server-only model override; defaults to `openai/gpt-oss-120b`. |

Keep Groq credentials in `.env.local` or the deployment provider's server environment settings. Never use a `NEXT_PUBLIC_` prefix. The application has no separate mandatory RPC credential; live Testnet reads still depend on reachable NEAR RPC endpoints.

## Deployment

The project uses Next.js App Router and the standard `next build` / `next start` scripts, so it can be imported into Vercel without a custom `vercel.json`. Set `RESCORA_NETWORK=near-testnet` in the deployment environment. Add `GROQ_API_KEY` only if the live Groq explanation is desired; without it, demo fallback remains available. `GROQ_MODEL` is optional. A successful build does not establish that live RPC access works, and this repository has not been deployed or verified on Vercel.

## Validation commands

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
corepack pnpm test
corepack pnpm build
```

`corepack pnpm check:env` verifies the required network configuration. `/api/health` reports application configuration and the current integration scope; it does not prove Burrow assessment readiness.
