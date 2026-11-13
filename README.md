# RESCORA

RESCORA is a read-only NEAR lending-position risk assessment prototype. It helps users inspect a lending position, understand an illustrative liquidation-risk calculation, and review bounded repayment candidates before taking any action.

The current prototype has two separate paths:

- **Explore Demo:** a wallet-free synthetic position journey that works without NEAR RPC or an AI API key.
- **Live Connection:** an experimental, read-only NEAR Testnet wallet and Burrow assessment path. Live Burrow position reads are not currently validated end-to-end.

RESCORA does not approve, sign, construct, or submit repayment transactions. The demo is synthetic and must not be mistaken for real account data.

**Repository:** https://github.com/sumitkr121003/rescora
**Hosted demo:** No hosted deployment is currently claimed. Follow the local setup below.

## The problem

A lending position can approach liquidation as collateral value falls or debt rises. Users need to understand their position's risk and evaluate possible repayment amounts without confusing an AI-generated explanation with authoritative protocol data or permission to move funds.

RESCORA explores a safer workflow: inspect a position, calculate risk deterministically, generate bounded repayment candidates, explain the result, and leave the final decision with the user.

## Try the demo

The demo is the reliable way to evaluate the current user journey. It does not require a wallet, testnet funds, `FASTNEAR_API_KEY`, or `GROQ_API_KEY`.

1. Start the app using the local setup instructions.
2. Open `http://localhost:3000`.
3. Select **Explore Demo**.
4. Inspect the synthetic position overview. The displayed collateral, debt, prices, and repayment balance are fixture values.
5. Inspect the deterministic risk result and the two repayment candidates.
6. Read the recommendation explanation. When Groq is unavailable, the app uses a deterministic local explanation.
7. Select a candidate to open its review-only repayment plan. Confirm that the plan displays the candidate's fixture amount and does not offer a transaction submission or success state.
8. Switch to **Live Connection** to see the separate Testnet path. A failed live read must remain unavailable; it must never be replaced with synthetic demo data.

### Synthetic demo position

| Input | Demo value |
| --- | ---: |
| Collateral | 2,000 NEAR |
| Collateral price | $4 per NEAR |
| Debt | 6,500 USDC |
| Debt price | $1 per USDC |
| Available demo repayment balance | 3,000 USDC |
| Assumed collateral factor | 0.75 |
| Assumed risk boundary | 1.00 |

The illustrative health factor is:

```text
(2,000 × $4 × 0.75) ÷ (6,500 × $1)
= 6,000 ÷ 6,500
≈ 0.92
```

The collateral factor and risk boundary are demo assumptions, not verified Burrow protocol parameters. Prices are fixed fixture values, not live oracle prices.

The demo offers preset repayment candidates of 1,000 USDC and 2,000 USDC. Candidate values are bounded by the fixture debt and synthetic repayment balance. The values are illustrative and do not represent funds owned by a connected wallet.

## What is implemented

- A wallet-free synthetic demo journey.
- Deterministic health-factor calculation for the demo fixture.
- Two bounded, deterministic repayment candidates.
- An optional Groq explanation and candidate selection flow.
- A deterministic local explanation fallback when Groq is unavailable or returns an unusable response.
- A review-only repayment plan with no transaction execution.
- A separate NEAR Testnet wallet connection and experimental Burrow read path.
- User-facing unavailable and error states that do not silently substitute synthetic data for live data.

## NEAR and Burrow integration

RESCORA uses NEAR Testnet as the target environment for its live assessment path.

- **Wallet:** NEAR Wallet Selector with the Meteor Wallet module. The app obtains the selected account and attempts independent Testnet identity verification. A connected account display is not, by itself, proof that identity verification succeeded.
- **Burrow:** the read path targets `burrow.services.ref-labs.testnet`, including the `get_account_all_positions` view method.
- **RPC access:** Burrow reads are routed through the application's server-side RPC proxy rather than exposing arbitrary RPC method calls from the browser.
- **Network scope:** `RESCORA_NETWORK=near-testnet` is an application configuration guard. It does not itself connect a wallet, prove the connected account is on Testnet, or establish that Burrow data is available.

### Live integration status and limitations

**Live Burrow position reads are not currently verified end-to-end.** During development, requests to the approved NEAR Testnet RPC providers failed with transport errors in the target environment. This does not prove that an account has no Burrow position; it means the app could not establish a trustworthy read.

The following have not passed validation against the deployed Burrow Testnet contract:

- Contract and deployed implementation equivalence.
- Complete and reliable live position responses.
- Token decimal and unit interpretation across all required assets.
- Oracle price authenticity and freshness.
- Matching the risk model to the deployed protocol's exact risk mechanics.

For these reasons, the app does not present unverified live balances as a completed risk assessment and does not generate live repayment recommendations. A successful wallet connection or HTTP response from the app's own API is not proof that a Burrow position was read successfully.

No mainnet assessment, repayment execution, token swap, external funding, or autonomous transaction flow is implemented.

## Risk calculation

The deterministic risk module reproduces the available RHEA SDK weighted collateral/debt formula using explicit balances, decimal scales, prices, and volatility ratios.

It uses exact integer rational arithmetic, preserves the SDK ratio cap, and returns an unverified model result without assigning an authoritative liquidation classification. Missing or invalid inputs fail closed.

This is a model implementation, not proof that the formula matches the currently deployed Burrow Testnet contract. The synthetic demo uses its own explicitly stated assumptions.

## Groq's restricted role

Groq is optional and used only for the synthetic demo.

The server route provides the synthetic fixture and deterministic candidate IDs. Groq may select one of those existing candidate IDs and produce a bounded qualitative explanation. The response schema does not contain a repayment amount field, and server-side validation rejects selections that do not match the supplied candidates.

Groq cannot:

- Change collateral, debt, prices, health factors, or repayment amounts.
- Create a new repayment candidate.
- Access a connected wallet or private key.
- Call NEAR RPC or read live Burrow positions.
- Approve, sign, or submit a transaction.

If the API key is absent, the request times out, the provider fails, or the response is invalid, the demo uses a deterministic local explanation instead. Groq is an external AI service; this is not a private-inference or confidential-computing claim.

## Local setup

### Requirements

- Node.js 22.9 or newer.
- Corepack.
- Git.
- pnpm 11.25.0, provided through Corepack.

### Windows PowerShell

Clone the public repository:

```powershell
git clone https://github.com/sumitkr121003/rescora.git
cd rescora
```

Install dependencies and create the local environment file:

```powershell
corepack pnpm install --frozen-lockfile

if (-not (Test-Path .env.local)) {
    Copy-Item .env.example .env.local
}
```

Confirm `.env.local` contains:

```text
RESCORA_NETWORK=near-testnet
```

Validate the environment and start the development server:

```powershell
corepack pnpm check:env
corepack pnpm exec next dev
```

Open `http://localhost:3000`.

The Corepack commands above deliberately run the environment check and Next.js directly. The package's `dev` script invokes `pnpm` internally; on Windows installations where the pnpm shim is not on `PATH`, that nested invocation may fail even when `corepack pnpm` works.

The synthetic demo does not need a wallet or optional API credentials. Meteor Wallet is needed only to try the separate wallet connection and experimental live read path.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESCORA_NETWORK` | Yes | Must be `near-testnet`. Declares the application's configured network scope; it does not establish a live connection. |
| `FASTNEAR_API_KEY` | No | Optional server-side credential for the FastNear NEAR Testnet RPC provider used by the live read path. |
| `GROQ_API_KEY` | No | Optional server-only credential for the synthetic demo explanation and candidate selection. |
| `GROQ_MODEL` | No | Optional server-only Groq model override. Defaults to `openai/gpt-oss-120b`. |

Keep credentials in `.env.local` or the deployment provider's server environment settings. Never use a `NEXT_PUBLIC_` prefix for server credentials. Do not commit `.env.local` or API keys.

## Validation

Run these checks from the project directory:

```powershell
corepack pnpm check:env
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm exec next build
```

The explicit `check:env` and `next build` commands avoid the nested plain-`pnpm` call in the package's `build` script on Windows systems where pnpm is not directly on `PATH`.

The latest reported full validation during development on 12 November 2026 was 205 passing tests across 22 files, with typecheck, lint, formatting check, and production build passing. Re-run the commands above against the exact revision being evaluated.

`/api/health` reports application configuration and integration scope. It does not prove that a live Burrow position can be read.

## Hackathon scope and provenance

**Intended track:** Unstoppable DeFi (`defi`), focused on NEAR lending-position risk assessment. RESCORA does not claim to implement NEAR Intents or Chain Signatures.

The repository's recorded Git history begins on 3 November 2026 with commit `080b1c9` (`chore: initialize RESCORA application`). The visible development history records subsequent work through 12 November 2026. The repository history does not show pre-hackathon commits.

This section describes the history recorded in this repository; Git timestamps alone do not prove when every uncommitted or externally developed line of code was first created.

The project uses Next.js, React, TypeScript, NEAR Wallet Selector/Meteor Wallet, NEAR Testnet RPC, and the optional Groq API. The risk calculation is based on the available RHEA SDK weighted collateral/debt formula. No proprietary model or private AI integration is claimed.

See the official [NEAR HACKATHON instructions](https://nearhackathon.com/HACKATHON.md) for submission rules. The repository must remain public through judging. The project must also have a public X demo post that says it was built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, and includes a demo video or screenshots.

## Current limitations

- Live Burrow position reads are not verified end-to-end.
- Live risk calculations are not validated against the deployed Burrow contract.
- Demo prices and position values are synthetic and fixed.
- Groq is optional and is not a private AI integration.
- No repayment approval, signing, transaction construction, transaction submission, swaps, or external funding.
- No mainnet functionality.
- No hosted deployment is currently claimed.

RESCORA is a prototype for risk visibility and review-only repayment planning. It does not guarantee liquidation prevention and must not be used as the basis for a real financial decision.