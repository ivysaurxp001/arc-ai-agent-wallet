#!/bin/bash
# Script to update backend/.env with deployed contract address

CONTRACT_ADDRESS="0x4269805051a94630e145F8A179764E2f6b8D3B95"
OWNER_PRIVATE_KEY="0xb7a86c042c5adfb53e43f3e292fc33cbeb1dde73e38d0c2f9be97aecab665285"

cd backend

if [ ! -f .env ]; then
  echo "Creating backend/.env from env.example..."
  cp env.example .env
fi

# Update AGENT_WALLET_ADDRESS
if grep -q "AGENT_WALLET_ADDRESS=" .env; then
  sed -i "s|AGENT_WALLET_ADDRESS=.*|AGENT_WALLET_ADDRESS=$CONTRACT_ADDRESS|" .env
else
  echo "AGENT_WALLET_ADDRESS=$CONTRACT_ADDRESS" >> .env
fi

# Update OWNER_PRIVATE_KEY
if grep -q "OWNER_PRIVATE_KEY=" .env; then
  sed -i "s|OWNER_PRIVATE_KEY=.*|OWNER_PRIVATE_KEY=$OWNER_PRIVATE_KEY|" .env
else
  echo "OWNER_PRIVATE_KEY=$OWNER_PRIVATE_KEY" >> .env
fi

# Ensure other required vars exist
if ! grep -q "ARC_RPC_URL=" .env; then
  echo "ARC_RPC_URL=https://rpc.testnet.arc.network" >> .env
fi

if ! grep -q "USDC_ADDRESS=" .env; then
  echo "USDC_ADDRESS=0x3600000000000000000000000000000000000000" >> .env
fi

if ! grep -q "PORT=" .env; then
  echo "PORT=3001" >> .env
fi

echo "✅ Updated backend/.env with:"
echo "   AGENT_WALLET_ADDRESS=$CONTRACT_ADDRESS"
echo "   OWNER_PRIVATE_KEY=$OWNER_PRIVATE_KEY"
echo ""
echo "You can now start the backend with:"
echo "   cd backend && npm install && npm run dev"

