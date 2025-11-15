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

## Deployment

### Frontend (Vercel)

1. Push code to GitHub
2. Import project in Vercel
3. **Set Environment Variable:**
   - Go to Project Settings → Environment Variables
   - Add: `VITE_API_URL` = `https://your-backend-url.com` (no trailing slash)
4. Deploy

### Backend (Railway/Render/Fly.io)

**Option 1: Railway**
1. Go to [Railway](https://railway.app) and create new project
2. Connect your GitHub repo
3. **Set Root Directory (IMPORTANT):**
   - Click on your service → **Settings** tab
   - Look for **"Source"** section
   - Find **"Root Directory"** field (or **"Working Directory"**)
   - Enter: `backend`
   - Click **Save**
   - **Alternative:** If you don't see this option, Railway will use `railway.json` at root (already configured)
4. **Add Environment Variables:**
   - Go to **Variables** tab
   - Add these variables:
     ```
     ARC_RPC_URL=https://rpc.testnet.arc.network
     AGENT_WALLET_ADDRESS=0x4269805051a94630e145F8A179764E2f6b8D3B95
     USDC_ADDRESS=0x3600000000000000000000000000000000000000
     OWNER_PRIVATE_KEY=0x<your_owner_private_key>
     PORT=3001
     ```
5. Railway will use build commands from `railway.json` (builds from `backend/` directory)
6. Deploy (auto-deploys on push to main branch)
7. **Get Backend URL:**
   - After deployment, go to your service → **Settings** tab
   - Scroll to **"Networking"** section
   - Find **"Public Domain"** or click **"Generate Domain"**
   - Copy the URL (e.g., `https://your-service.up.railway.app`)
   - **Test it:** Open `https://your-service.up.railway.app/healthz` in browser
   - Should see: `{"status":"ok","chainId":5042002,...}`

**Option 2: Render**
1. Create new Web Service
2. Set root directory to `backend`
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Add environment variables (same as above)

**Important:** After deploying backend, update `VITE_API_URL` in Vercel with your backend URL.

### Next Steps After Backend Deployment

1. **Test Backend:**
   ```bash
   curl https://your-railway-url.up.railway.app/healthz
   ```
   Should return: `{"status":"ok",...}`

2. **Configure Vercel Frontend:**
   - Go to Vercel Dashboard → Your Project → **Settings** → **Environment Variables**
   - Add new variable:
     - **Key:** `VITE_API_URL`
     - **Value:** `https://your-railway-url.up.railway.app` (no trailing slash)
   - **Redeploy** frontend (or push a commit to trigger auto-deploy)

3. **Verify Connection:**
   - Open your Vercel frontend URL
   - Open browser DevTools → Network tab
   - Try creating an agent
   - Check if API calls go to your Railway backend URL (not `/api`)

4. **Troubleshooting:**
   - If you see CORS errors, backend CORS is already configured to allow all origins
   - If API calls fail, check Railway logs: Service → **Deployments** → Click latest deployment → **View Logs**
   - Ensure all environment variables are set correctly in Railway

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

