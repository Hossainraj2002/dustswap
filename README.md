# 🧹 DustSweep Protocol

Turn wallet dust into gold on Base — batch sweep up to 25 dust tokens into ETH/USDC in one Smart Wallet signature, gas sponsored.

---

## Base UX Integrations

This project uses three Base-specific UX improvements:

### 1. Batch Transactions
All token approvals + the sweep call are bundled into a single `wallet_sendCalls` batch via `useWriteContracts` (wagmi experimental). Users sign **once** instead of N+1 times.

- Hook: `apps/web/src/hooks/useDustSweep.ts`
- Docs: https://docs.base.org/base-account/improve-ux/batch-transactions

### 2. Sponsored Gas (Paymaster)
When `NEXT_PUBLIC_PAYMASTER_URL` is set, the batch call includes `paymasterService` capabilities. The paymaster covers gas so users pay **$0 ETH**.

- Set up a paymaster: https://portal.cdp.coinbase.com → Paymaster
- Docs: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters

### 3. Builder Codes
`NEXT_PUBLIC_BASE_BUILDER_CODE` is appended as `?builderCode=<code>` to every Alchemy RPC URL. Base rebates a share of gas fees to DustSweep.

- Apply at: https://base.org/builders/builder-codes
- Docs: https://docs.base.org/base-chain/builder-codes/app-developers

---

## Project Structure

```
dustsweep/
├── packages/
│   └── contracts/          ← Foundry smart contracts
│       ├── src/
│       │   ├── FeeCollector.sol
│       │   ├── BurnVault.sol
│       │   └── DustSweepRouter.sol
│       ├── test/
│       │   └── DustSweepRouter.t.sol
│       └── script/
│           └── Deploy.s.sol
└── apps/
    ├── web/                ← Next.js 14 frontend
    │   └── src/
    │       ├── app/
    │       │   ├── providers.tsx   ← wagmi + paymaster + builder code
    │       │   ├── page.tsx        ← Landing page
    │       │   └── app/
    │       │       ├── dust-sweep/ ← Main feature
    │       │       ├── particles/  ← Points dashboard
    │       │       ├── swap/       ← OnchainKit swap
    │       │       ├── burn/       ← Burn & reclaim
    │       │       └── dust-bridge/
    │       ├── components/
    │       │   └── Navbar.tsx
    │       ├── hooks/
    │       │   ├── useDustSweep.ts  ← Batch TX + paymaster
    │       │   └── useBurnVault.ts  ← Batch TX + paymaster
    │       └── lib/
    │           └── contracts.ts
    └── api/                ← Express backend
        └── src/
            ├── index.ts
            ├── schema.sql          ← Run in Supabase SQL Editor
            ├── routes/
            │   ├── health.ts
            │   ├── tokens.ts
            │   └── points.ts
            └── services/
                ├── tokenDiscovery.ts
                └── pointsEngine.ts
```

---

## Quick Start

### 1. Prerequisites
- Node.js v20+, pnpm, Git
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Accounts: Alchemy, Supabase, Coinbase CDP

### 2. Install dependencies

```bash
# Frontend
cd apps/web && pnpm install

# Backend
cd apps/api && pnpm install
```

### 3. Configure environment

```bash
# Contracts
cp packages/contracts/.env.example packages/contracts/.env
# Fill in BASE_SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY

# Frontend
cp apps/web/.env.example apps/web/.env.local
# Fill in ALCHEMY, ONCHAINKIT keys, contract addresses after deploy

# Backend
cp apps/api/.env.example apps/api/.env
# Fill in ALCHEMY, SUPABASE, REDIS
```

### 4. Deploy contracts to Base Sepolia

```bash
cd packages/contracts

# Install dependencies
forge install OpenZeppelin/openzeppelin-contracts --no-commit

# Run tests
forge test -vvv

# Deploy
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast --verify -vvv

# Copy printed addresses into apps/web/.env.local
```

### 5. Set up Supabase database

1. Go to https://app.supabase.com → your project → SQL Editor
2. Open and run `apps/api/src/schema.sql`

### 6. Start development

```bash
# Terminal 1: Backend
cd apps/api && pnpm dev

# Terminal 2: Frontend
cd apps/web && pnpm dev

# Open http://localhost:3000
```

---

## Environment Variables Reference

### `apps/web/.env.local`

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | ✅ | Alchemy API key |
| `NEXT_PUBLIC_ONCHAINKIT_API_KEY` | ✅ | From portal.cdp.coinbase.com |
| `NEXT_PUBLIC_PAYMASTER_URL` | Optional | Enables sponsored gas |
| `NEXT_PUBLIC_BASE_BUILDER_CODE` | Optional | Earns gas fee rebates |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | ✅ | Deployed DustSweepRouter |
| `NEXT_PUBLIC_BURN_VAULT_ADDRESS` | ✅ | Deployed BurnVault |
| `NEXT_PUBLIC_NETWORK` | ✅ | `testnet` or `mainnet` |

### `apps/api/.env`

| Variable | Required | Description |
|---|---|---|
| `ALCHEMY_API_KEY` | ✅ | For token scanning |
| `SUPABASE_URL` | ✅ | Database |
| `SUPABASE_ANON_KEY` | ✅ | Database auth |
| `REDIS_URL` | Optional | Caching |

---

## Points System

| Action | Points | Multiplier | Daily Cap |
|---|---|---|---|
| Daily check-in | 50 | 1× | 50 |
| Swap | 50 | 1× | 500 |
| Dust sweep (per token) | 50 | **5×** = 250 | 5,000 |
| Dust bridge (per token) | 50 | **10×** = 500 | 10,000 |
| Burn (per token) | 50 | **2×** = 100 | 2,000 |
| Referral signup | 500 | — | — |
| Referral commission | 10% of referee | ongoing | — |
| 7-day streak bonus | 500 | — | — |
| 30-day streak bonus | 5,000 | — | — |
| 90-day streak bonus | 20,000 | — | — |

---

## Deployment

### Frontend → Vercel
```bash
# Push to GitHub, then import at vercel.com
# Set root directory: apps/web
# Add all NEXT_PUBLIC_ env vars
```

### Backend → Railway
```bash
# Import GitHub repo at railway.app
# Set root directory: apps/api
# Start command: pnpm start
# Add all env vars
```

### Contracts → Base Mainnet
```bash
# Update .env with BASE_RPC_URL
# Change Deploy.s.sol uniRouter to mainnet address
# forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC_URL --broadcast --verify
```

---

## Security Notes

- Contracts use OpenZeppelin ReentrancyGuard on all state-changing functions
- Emergency pause on DustSweepRouter for incident response
- Token rescue functions for stuck funds
- Max batch size: 25 tokens per sweep
- Fee ceiling: 5% (hardcoded `MAX_FEE_BPS`)
- Run `slither packages/contracts/src/` before mainnet deployment
# dustswap
