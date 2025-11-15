#!/bin/bash
# Script to get contract address from deployment transaction hash

if [ -z "$1" ]; then
  echo "Usage: ./scripts/get-contract-address.sh <transaction_hash>"
  echo "Example: ./scripts/get-contract-address.sh 0x1234..."
  exit 1
fi

TX_HASH=$1
RPC_URL=${ARC_RPC_URL:-https://rpc.testnet.arc.network}

echo "Fetching transaction receipt for: $TX_HASH"
echo "RPC URL: $RPC_URL"
echo ""

# Use cast to get contract address from transaction receipt
CONTRACT_ADDRESS=$(cast receipt $TX_HASH --rpc-url $RPC_URL contractAddress 2>/dev/null)

if [ -z "$CONTRACT_ADDRESS" ] || [ "$CONTRACT_ADDRESS" = "null" ]; then
  echo "❌ Could not find contract address. Make sure:"
  echo "   1. Transaction hash is correct"
  echo "   2. Transaction is confirmed on chain"
  echo "   3. RPC URL is accessible"
  exit 1
fi

echo "✅ Contract deployed at: $CONTRACT_ADDRESS"
echo ""
echo "Add this to your backend/.env:"
echo "AGENT_WALLET_ADDRESS=$CONTRACT_ADDRESS"
echo ""
echo "Or update manually:"
echo "  cd backend"
echo "  nano .env"
echo "  # Set AGENT_WALLET_ADDRESS=$CONTRACT_ADDRESS"

