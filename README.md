# Arc Agent Wallet

A dApp that enables AI agents to autonomously spend USDC on Arc Testnet with on-chain spending policies enforced by smart contracts.

**Contract Address:** `0x4269805051a94630e145F8A179764E2f6b8D3B95`

## What It Solves

AI agents need to pay for services (LLM APIs, Vector DBs, infrastructure, SaaS subscriptions) but currently require manual payment approval. This project enables **autonomous agent payments** with built-in spending controls.

## Real-World Use Cases

### 1. AI Research & Development
- **Problem:** AI assistants need to call multiple paid APIs (OpenAI, Anthropic, Vector DBs) continuously
- **Solution:** Agent automatically pays for API calls within daily/per-tx limits
- **Example:** Research bot with 100 USDC/day limit, whitelisted merchants only

### 2. Infrastructure Management
- **Problem:** Auto-scaling infrastructure requires manual payment for VPS, storage, CDN
- **Solution:** Agent automatically renews subscriptions and scales resources
- **Example:** Infrastructure bot with 200 USDC/day limit for cloud services

### 3. SaaS Subscriptions
- **Problem:** Multiple SaaS tools need recurring payments
- **Solution:** Agent auto-renews subscriptions within budget constraints
- **Example:** Content bot with 50 USDC/day for image/video generation services

### 4. Multi-Agent Systems
- **Problem:** Different agents need different budgets and policies
- **Solution:** Each agent has independent wallet with custom limits
- **Example:** Research bot (50 USDC/day), Trading bot (200 USDC/day), Content bot (30 USDC/day)

## Key Features

- ✅ **Daily & Per-Transaction Limits** - Enforced on-chain, cannot be bypassed
- ✅ **Merchant Whitelist** - Only approved addresses can receive payments
- ✅ **Pause Anytime** - Owner can instantly stop agent spending
- ✅ **On-Chain Transparency** - All transactions visible on explorer
- ✅ **24/7 Automation** - No manual approval needed

## Why Arc Network?

- **Low Gas Fees** (~1 cent/transaction) - Perfect for micro-payments
- **USDC as Gas** - No separate native token needed
- **Fast Finality** (<1 second) - Real-time payment processing
- **Agentic Commerce Focus** - Built for AI agent use cases

## Quick Start

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Configure Backend

```bash
cd backend
cp env.example .env
```

Edit `backend/.env`:
```env
ARC_RPC_URL=https://rpc.testnet.arc.network
AGENT_WALLET_ADDRESS=0x4269805051a94630e145F8A179764E2f6b8D3B95
USDC_ADDRESS=0x3600000000000000000000000000000000000000
OWNER_PRIVATE_KEY=0x<your_owner_private_key>
PORT=3001
```

### 3. Run Application

```bash
npm run dev
```

- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173`

## Project Structure

```
.
├── src/AgentWallet.sol          # Smart contract
├── backend/                     # Node.js/TypeScript relayer API
├── frontend/                     # React + Vite dashboard
└── test/                         # Foundry tests
```

## How It Works

1. **Create Agent** - Owner deploys agent with spending limits (daily/per-tx)
2. **Deposit USDC** - Fund the agent wallet
3. **Whitelist Merchants** - Approve which addresses can receive payments
4. **Agent Pays** - AI agent autonomously sends payments within limits
5. **Monitor** - Owner tracks spending via dashboard or on-chain explorer

## API Endpoints

- `POST /register-agent` - Create new agent
- `POST /agent/pay` - Execute payment
- `POST /agent/whitelist` - Update merchant whitelist
- `GET /agent/:agentId` - Get agent details
- `GET /healthz` - Health check

## Security Notes

- Agent private keys stored in backend memory (demo only)
- Production should use secure key management (HSM, vault)
- All spending rules enforced on-chain
- Owner can pause/withdraw at any time

## Resources

- [Arc Network Docs](https://docs.arc.network)
- [Arc Testnet Explorer](https://testnet.arcscan.app)
- [Use Cases](./USE_CASES.md) - Detailed use case scenarios
- [Security](./SECURITY.md) - Security considerations
- Circle Faucet: <https://faucet.circle.com> (select Arc Testnet)

## License

MIT

