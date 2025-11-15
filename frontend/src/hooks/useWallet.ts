import { useState, useEffect } from "react";
import { createPublicClient, createWalletClient, custom, http, Chain, Hex } from "viem";
import { toAccount } from "viem/accounts";

const arcChain: Chain = {
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public: { http: ["https://rpc.testnet.arc.network"] }
  }
};

export const useWallet = () => {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publicClient = createPublicClient({
    chain: arcChain,
    transport: http()
  });

  useEffect(() => {
    // Check if already connected
    if (typeof window !== "undefined" && window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            setAddress(accounts[0] as `0x${string}`);
          }
        })
        .catch(() => {
          // Ignore errors
        });
    }
  }, []);

  const connect = async () => {
    if (typeof window === "undefined" || !window.ethereum) {
      setError("MetaMask not found. Please install MetaMask.");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      // Request account access
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts"
      });

      if (accounts.length > 0) {
        setAddress(accounts[0] as `0x${string}`);
      }

      // Check chain
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      const targetChainId = `0x${arcChain.id.toString(16)}`;

      if (chainId !== targetChainId) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: targetChainId }]
          });
        } catch (switchError: any) {
          // Chain doesn't exist, add it
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: targetChainId,
                  chainName: arcChain.name,
                  nativeCurrency: arcChain.nativeCurrency,
                  rpcUrls: arcChain.rpcUrls.default.http
                }
              ]
            });
          } else {
            throw switchError;
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to connect wallet");
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = () => {
    setAddress(null);
    setError(null);
  };

  const getWalletClient = () => {
    if (typeof window === "undefined" || !window.ethereum || !address) {
      return null;
    }

    // For MetaMask with custom transport, we need to create an account object from the address
    // This account object will be used by viem to identify which account to use
    const account = toAccount(address);

    return createWalletClient({
      chain: arcChain,
      transport: custom(window.ethereum),
      account
    });
  };

  return {
    address,
    isConnected: !!address,
    isConnecting,
    error,
    connect,
    disconnect,
    getWalletClient,
    publicClient,
    chain: arcChain
  };
};

// Extend Window interface
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}


