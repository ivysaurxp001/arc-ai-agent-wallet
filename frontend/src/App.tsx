import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { FormEvent, useMemo, useState, useEffect, useRef } from "react";

import {
  AgentPayResponse,
  AgentDetailsResponse,
  RegisterAgentResponse,
  DepositResponse,
  executePayment,
  fetchAgentDetails,
  registerAgent,
  whitelistMerchant,
  depositToAgent,
  prepareAgentCreation,
  completeAgentCreation,
  prepareDeposit,
  pauseResumeAgent,
  withdrawFromAgent,
  preparePayment,
  prepareWhitelist
} from "./api/client";
import { formatBaseUnits, parseUsdToBaseUnits } from "./utils/amount";
import { useWallet } from "./hooks/useWallet";
import { WalletButton } from "./components/WalletButton";
import { encryptPrivateKey, decryptPrivateKey, isEncrypted } from "./utils/encryption";
import { agentWalletAbi } from "./abi/agentWalletAbi";
import { erc20Abi } from "./abi/erc20Abi";
import { decodeEventLog, createWalletClient, createPublicClient, http, serializeTransaction, toSerializableTransaction, parseEther, formatEther, getAddress, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

// Contract address - should match backend
const AGENT_WALLET_ADDRESS = "0x4269805051a94630e145F8A179764E2f6b8D3B95" as `0x${string}`;

type AgentSummary = {
  agentId: number;
  agentAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  privateKey: `0x${string}` | string; // Can be encrypted string or plain private key
  transactionHash: `0x${string}`;
  encrypted?: boolean; // Flag to indicate if private key is encrypted
};

type LogEntry = {
  id: number;
  message: string;
};

const initialRegisterForm = {
  dailyLimit: "250.00",
  perTxLimit: "25.00"
};

const initialPaymentForm = {
  merchant: "",
  amount: "1.00",
  data: ""
};

const initialDepositForm = {
  amount: "10.00"
};

const initialFundGasForm = {
  amount: "0.01" // Native USDC for gas
};

const AGENTS_STORAGE_KEY = "arc-agent-wallet-agents";
const ENCRYPTION_PASSWORD_KEY = "arc-agent-wallet-encryption-password"; // Store password hash, not plain password

// Helper to deserialize BigInt recursively (convert string back to BigInt for viem)
const deserializeBigInt = (obj: any): any => {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === "string" && /^\d+$/.test(obj)) {
    return BigInt(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deserializeBigInt);
  }
  if (typeof obj === "object") {
    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = deserializeBigInt(obj[key]);
      }
    }
    return result;
  }
  return obj;
};

const App = () => {
  const wallet = useWallet();
  
  // Password modal state
  const [passwordModal, setPasswordModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    resolve: ((value: string | null) => void) | null;
  }>({
    open: false,
    title: "",
    message: "",
    resolve: null
  });
  
  const [passwordInput, setPasswordInput] = useState("");
  
  // Helper function to show password modal
  const showPasswordModal = (
    title: string,
    message: string
  ): Promise<string | null> => {
    return new Promise((resolve) => {
      setPasswordInput("");
      setPasswordModal({
        open: true,
        title,
        message,
        resolve
      });
    });
  };
  
  // Handle confirm button click
  const handlePasswordConfirm = () => {
    if (passwordModal.resolve) {
      const password = passwordInput.trim();
      passwordModal.resolve(password.length > 0 ? password : null);
      setPasswordModal({ open: false, title: "", message: "", resolve: null });
      setPasswordInput("");
    }
  };
  
  // Handle cancel button click
  const handlePasswordCancel = () => {
    if (passwordModal.resolve) {
      passwordModal.resolve(null);
      setPasswordModal({ open: false, title: "", message: "", resolve: null });
      setPasswordInput("");
    }
  };
  
  // Handle Enter key in password modal
  const handlePasswordKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && passwordInput.length > 0) {
      handlePasswordConfirm();
    }
  };
  
  // Load agents from localStorage on mount
  const [agents, setAgents] = useState<AgentSummary[]>(() => {
    try {
      const stored = localStorage.getItem(AGENTS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        console.log("Loaded agents from localStorage:", parsed);
        // Check if any agent is missing private key
        parsed.forEach((agent: AgentSummary) => {
          if (!agent.privateKey) {
            console.warn(`Agent ${agent.agentId} is missing private key!`);
          }
        });
        return parsed;
      }
    } catch (error) {
      console.error("Failed to load agents from localStorage:", error);
    }
    return [];
  });
  
  // Save agents to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents));
    } catch (error) {
      console.error("Failed to save agents to localStorage:", error);
    }
  }, [agents]);
  
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [registerForm, setRegisterForm] = useState(initialRegisterForm);
  const [paymentForm, setPaymentForm] = useState(initialPaymentForm);
  const [depositForm, setDepositForm] = useState(initialDepositForm);
  const [fundGasForm, setFundGasForm] = useState(initialFundGasForm);
  const [whitelistMerchantAddress, setWhitelistMerchantAddress] = useState("");
  const [whitelistAllowed, setWhitelistAllowed] = useState(true);

  // Filter agents to only show those owned by connected wallet
  const ownedAgents = useMemo(() => {
    if (!wallet.address) return [];
    return agents.filter(
      (agent) => agent.ownerAddress.toLowerCase() === wallet.address!.toLowerCase()
    );
  }, [agents, wallet.address]);

  const selectedAgent = useMemo(
    () => ownedAgents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [ownedAgents, selectedAgentId]
  );

  const { data: agentDetails, refetch: refetchAgentDetails, isFetching: isFetchingAgentDetails } = useQuery<
    AgentDetailsResponse
  >({
    queryKey: ["agentDetails", selectedAgentId],
    enabled: selectedAgentId !== null,
    queryFn: async () => {
      if (selectedAgentId === null) {
        throw new Error("No agent selected");
      }
      return fetchAgentDetails(selectedAgentId);
    }
  });

  // Query native balance of agent address (for gas)
  const { data: agentNativeBalance, refetch: refetchAgentNativeBalance } = useQuery<bigint>({
    queryKey: ["agentNativeBalance", selectedAgent?.agentAddress],
    enabled: selectedAgent?.agentAddress !== undefined && wallet.publicClient !== undefined,
    queryFn: async () => {
      if (!selectedAgent?.agentAddress || !wallet.publicClient) {
        throw new Error("Agent address or public client not available");
      }
      return await wallet.publicClient.getBalance({ address: selectedAgent.agentAddress });
    },
    refetchInterval: 10000 // Refetch every 10 seconds
  });

  // Use a counter to ensure unique IDs
  const logIdCounter = useRef(0);
  const appendLog = (message: string) => {
    setLogs((prev) => {
      logIdCounter.current += 1;
      return [{ id: `log-${Date.now()}-${logIdCounter.current}-${Math.random()}`, message }, ...prev].slice(0, 40);
    });
  };

  const registerMutation = useMutation({
    mutationFn: async (form: typeof initialRegisterForm): Promise<RegisterAgentResponse> => {
      const dailyLimit = parseUsdToBaseUnits(form.dailyLimit).toString();
      const perTxLimit = parseUsdToBaseUnits(form.perTxLimit).toString();

      // If wallet is connected, use frontend signing
      if (wallet.isConnected && wallet.address && wallet.getWalletClient()) {
        const walletClient = wallet.getWalletClient()!;
        
        // Prepare agent creation
        const prepareData = await prepareAgentCreation({
          dailyLimit,
          perTxLimit,
          ownerAddress: wallet.address
        });

        // Convert string back to BigInt for viem (recursive)
        const transactionRequest = deserializeBigInt(prepareData.transaction);

        // Sign and send transaction
        const hash = await walletClient.writeContract(transactionRequest as any);
        
        // Wait for receipt and get agentId from event
        const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
        
        let agentId: bigint | undefined;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: agentWalletAbi,
              topics: log.topics,
              data: log.data
            });
            if (decoded.eventName === "AgentCreated") {
              agentId = decoded.args.agentId as bigint;
              break;
            }
          } catch {
            continue;
          }
        }

        if (agentId === undefined) {
          throw new Error("Failed to find AgentCreated event");
        }

        // Complete registration on backend
        const result = await completeAgentCreation({
          agentId: Number(agentId),
          agentPrivateKey: prepareData.agentPrivateKey,
          agentAddress: prepareData.agentAddress,
          ownerAddress: wallet.address,
          dailyLimit,
          perTxLimit,
          transactionHash: hash
        });

        // Return result with private key (backend doesn't return it for security, but we have it from prepareData)
        return {
          ...result,
          agentPrivateKey: prepareData.agentPrivateKey,
          agentAddress: prepareData.agentAddress
        };
      } else {
        // Fallback to backend signing (legacy)
      return registerAgent({ dailyLimit, perTxLimit });
      }
    },
    onSuccess: async (data) => {
      const agentId = Number(data.agentId);
      
      // Verify private key exists
      if (!data.agentPrivateKey) {
        console.error("Agent created but private key is missing!", data);
        appendLog(`Warning: Agent ${agentId} created but private key is missing! This agent cannot make payments.`);
      }
      
      // Ask user if they want to encrypt the private key
      let privateKeyToStore: string = data.agentPrivateKey || "";
      let isEncryptedFlag = false;
      
      if (data.agentPrivateKey) {
        const encryptChoice = confirm(
          "Do you want to encrypt the agent private key with a password?\n\n" +
          "YES: More secure, but you'll need to enter password each time you make a payment.\n" +
          "NO: Less secure, but more convenient (stored in plain text).\n\n" +
          "Note: This is a testnet application. For production, encryption is recommended."
        );
        
        if (encryptChoice) {
          const password = await showPasswordModal(
            "Encrypt Private Key",
            "Enter a password to encrypt the private key. You'll need this password when making payments."
          );
          if (password && password.length > 0) {
            try {
              privateKeyToStore = await encryptPrivateKey(data.agentPrivateKey, password);
              isEncryptedFlag = true;
              appendLog("Private key encrypted and stored securely.");
            } catch (error) {
              appendLog(`Warning: Failed to encrypt private key: ${(error as Error).message}. Storing in plain text.`);
              privateKeyToStore = data.agentPrivateKey;
            }
          } else {
            appendLog("No password provided. Storing private key in plain text.");
            privateKeyToStore = data.agentPrivateKey;
          }
        }
      }
      
      const newAgent: AgentSummary = {
          agentId,
          agentAddress: data.agentAddress,
          ownerAddress: data.ownerAddress,
          privateKey: privateKeyToStore,
          transactionHash: data.transactionHash,
          encrypted: isEncryptedFlag
      };
      
      console.log("Adding new agent to state:", newAgent);
      
      setAgents((prev) => {
        // Check if agent already exists (avoid duplicates)
        if (prev.some((a) => a.agentId === agentId)) {
          console.warn(`Agent ${agentId} already exists, updating...`);
          return prev.map((a) => (a.agentId === agentId ? newAgent : a));
        }
        return [...prev, newAgent];
      });
      setSelectedAgentId(agentId);
      appendLog(
        `Agent ${agentId} created → address ${data.agentAddress}, tx ${shortHash(data.transactionHash)}`
      );
      if (data.agentPrivateKey && !isEncryptedFlag) {
        appendLog(
          `Agent Private Key: ${data.agentPrivateKey} (IMPORTANT: Store this securely! You need it for payments.)`
        );
      } else if (isEncryptedFlag) {
        appendLog(
          `Agent Private Key: [ENCRYPTED] (Password-protected. You'll need to enter password when making payments.)`
        );
      } else {
        appendLog(
          `WARNING: Agent private key is missing! This agent cannot make payments.`
        );
      }
      setRegisterForm(initialRegisterForm);
    },
    onError: (error) => {
      appendLog(`Failed to create agent: ${(error as Error).message}`);
    }
  });

  const whitelistMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = ownedAgents.find((a) => a.agentId === selectedAgentId);
      const agentOwner = agentInfo?.ownerAddress;

      if (!agentOwner) {
        throw new Error("Agent owner not found. Please select a valid agent.");
      }

      // Prepare whitelist transaction (backend will check if it can sign or return transaction for frontend)
      const prepareData = await prepareWhitelist({
        agentId: selectedAgentId,
        merchant: whitelistMerchantAddress,
        allowed: whitelistAllowed
      });

      // If backend already signed (backend owner matches agent owner)
      if (prepareData.transactionHash) {
        return prepareData;
      }

      // If needs frontend signing
      if (prepareData.needsSigning && prepareData.transaction) {
        // Check if wallet is connected and is the owner
        if (
          !wallet.isConnected ||
          !wallet.address ||
          !wallet.getWalletClient() ||
          wallet.address.toLowerCase() !== agentOwner.toLowerCase()
        ) {
          throw new Error(
            `Please connect wallet with owner address: ${agentOwner}. ` +
            `Current wallet: ${wallet.address || "not connected"}`
          );
        }

        const walletClient = wallet.getWalletClient()!;
        const publicClient = wallet.publicClient;

        // Frontend signing with owner wallet
        const deserializedTx = deserializeBigInt(prepareData.transaction);
        const hash = await walletClient.writeContract(deserializedTx);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        return {
          ...prepareData,
          transactionHash: hash,
          status: receipt.status
        };
      }

      throw new Error("Invalid response from whitelist endpoint");
    },
    onSuccess: (data) => {
      appendLog(
        `Merchant ${shortAddress(whitelistMerchantAddress)} ${
          whitelistAllowed ? "whitelisted" : "removed"
        } for agent ${selectedAgentId} (tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      setWhitelistMerchantAddress("");
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`Failed to update whitelist: ${(error as Error).message}`);
    }
  });

  const payMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null) throw new Error("Select an agent first");
      const amount = parseUsdToBaseUnits(paymentForm.amount).toString();
      const payload = {
        agentId: selectedAgentId,
        merchant: paymentForm.merchant,
        amount,
        data: paymentForm.data ? paymentForm.data : undefined
      };

      // Get agent private key from localStorage (if available)
      const agentInfo = ownedAgents.find((a) => a.agentId === selectedAgentId);
      let agentPrivateKey = agentInfo?.privateKey;

      // Decrypt private key if it's encrypted
      if (agentPrivateKey && isEncrypted(agentPrivateKey)) {
        // Get encryption password from user
        const password = await showPasswordModal(
          "Decrypt Private Key",
          "Enter password to decrypt agent private key for payment."
        );
        if (!password) {
          throw new Error("Password required to decrypt private key");
        }
        try {
          agentPrivateKey = await decryptPrivateKey(agentPrivateKey, password) as `0x${string}`;
        } catch (error) {
          throw new Error(`Failed to decrypt private key: ${(error as Error).message}. Wrong password?`);
        }
      }

      // If agent private key is available, use frontend signing
      if (agentPrivateKey) {
        let prepareData: any = null;
        try {
          // Prepare payment transaction
          prepareData = await preparePayment(payload);

          // Create agent account from private key
          const agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);
          const rpcUrl = import.meta.env.VITE_RPC_URL || "https://rpc.testnet.arc.network";
          const publicClient = wallet.publicClient || createPublicClient({
            chain: arcTestnet,
            transport: http(rpcUrl)
          });

          // Deserialize transaction
          const deserializedTx = deserializeBigInt(prepareData.transaction);
          
          // Log deserialized transaction to debug
          console.log("Deserialized transaction:", deserializedTx);
          
          // Backend returns simulateContract request object, not a transaction object
          // We need to encode the function call from the request object
          let toAddress: `0x${string}`;
          let txData: `0x${string}`;
          
          if (deserializedTx.to && deserializedTx.data) {
            // If it's already a transaction object with to and data
            toAddress = deserializedTx.to;
            txData = deserializedTx.data;
          } else if (deserializedTx.address && deserializedTx.functionName && deserializedTx.args) {
            // If it's a contract call request, encode the function call
            // Use ABI from backend if available, otherwise use frontend ABI
            const abiToUse = deserializedTx.abi && deserializedTx.abi.length > 0 
              ? deserializedTx.abi 
              : agentWalletAbi;
            
            toAddress = deserializedTx.address as `0x${string}`;
            txData = encodeFunctionData({
              abi: abiToUse as any,
              functionName: deserializedTx.functionName as any,
              args: deserializedTx.args as any
            });
            console.log("Encoded function data:", { 
              toAddress, 
              txData, 
              functionName: deserializedTx.functionName, 
              args: deserializedTx.args,
              abiLength: abiToUse.length,
              usingBackendAbi: deserializedTx.abi && deserializedTx.abi.length > 0
            });
          } else {
            console.error("Invalid transaction data:", deserializedTx);
            throw new Error("Invalid transaction: missing required fields. Expected either {to, data} or {address, functionName, args}.");
          }
          
          if (!toAddress || !txData || txData === "0x") {
            console.error("Invalid transaction data:", { toAddress, txData, deserializedTx });
            throw new Error("Invalid transaction: missing 'to' address or 'data'.");
          }
          
          // Get current nonce and gas price
          const [nonce, gasPrice, gas] = await Promise.all([
            publicClient.getTransactionCount({ address: agentAccount.address }),
            publicClient.getGasPrice(),
            publicClient.estimateGas({
              account: agentAccount,
              to: toAddress,
              data: txData,
              value: deserializedTx.value || 0n
            } as any).catch(() => deserializedTx.gas || 21000n)
          ]);

          // Prepare transaction for signing
          const transaction = {
            to: toAddress,
            data: txData,
            value: deserializedTx.value || 0n,
            gas: gas || deserializedTx.gas || 21000n,
            gasPrice: gasPrice || deserializedTx.gasPrice,
            nonce: nonce,
            chain: arcTestnet
          };
          
          console.log("Prepared transaction for signing:", transaction);
          
          // Sign transaction
          const signedTx = await agentAccount.signTransaction(transaction);
          
          // Send raw transaction
          const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedTx });
          
          // Log transaction details for debugging
          console.log("Payment transaction details:", {
            hash,
            to: deserializedTx.to,
            data: deserializedTx.data,
            from: agentAccount.address,
            expectedContract: AGENT_WALLET_ADDRESS
          });
          
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          
          // Also get the full transaction to verify it
          const fullTx = await publicClient.getTransaction({ hash });
          console.log("Full transaction:", {
            to: fullTx.to,
            input: fullTx.input,
            from: fullTx.from
          });

          // Check transaction status first
          if (receipt.status === "reverted") {
            console.error("Transaction reverted. Receipt:", receipt);
            throw new Error("Transaction reverted. Payment failed. Check contract state and policy settings.");
          }

          // Decode AgentPayment event from receipt to verify payment
          // Filter logs by contract address first
          const contractLogs = receipt.logs.filter(
            log => log.address.toLowerCase() === AGENT_WALLET_ADDRESS.toLowerCase()
          );

          console.log("Transaction receipt:", {
            status: receipt.status,
            totalLogs: receipt.logs.length,
            contractLogs: contractLogs.length,
            contractAddress: AGENT_WALLET_ADDRESS
          });

          let paymentEvent: any = null;
          for (const log of contractLogs) {
            try {
              const decoded = decodeEventLog({
                abi: agentWalletAbi,
                topics: log.topics,
                data: log.data
              });
              if (decoded.eventName === "AgentPayment") {
                paymentEvent = decoded;
                console.log("AgentPayment event found:", {
                  agentId: decoded.args.agentId?.toString(),
                  merchant: decoded.args.merchant,
                  amount: decoded.args.amount?.toString(),
                  data: decoded.args.data
                });
                break;
              }
            } catch (error) {
              // Not an AgentPayment event or not from our contract, continue
              console.debug("Failed to decode log:", error);
            }
          }

          // If no event found but transaction succeeded, still return success
          // (event might be filtered or contract might not emit it in some cases)
          if (!paymentEvent) {
            console.warn("AgentPayment event not found in receipt logs, but transaction succeeded");
            console.warn("All logs:", receipt.logs.map(log => ({
              address: log.address,
              topics: log.topics,
              data: log.data
            })));
            
            // Still return success if transaction status is success
            // The payment might have succeeded even without event
            if (receipt.status === "success") {
              console.warn("Transaction succeeded but no AgentPayment event found. Payment may have succeeded anyway.");
              return {
                transactionHash: hash,
                agentId: selectedAgentId,
                merchant: paymentForm.merchant,
                amount: amount.toString(),
                status: receipt.status,
                paymentEvent: null // No event found
              };
            } else {
              throw new Error("Payment transaction failed or reverted.");
            }
          }

          // Verify payment event matches expected values
          const eventAmount = paymentEvent.args.amount?.toString() || amount.toString();
          const eventMerchant = paymentEvent.args.merchant || paymentForm.merchant;
          const eventAgentId = Number(paymentEvent.args.agentId) || selectedAgentId;

          return {
            transactionHash: hash,
            agentId: eventAgentId,
            merchant: eventMerchant,
            amount: eventAmount,
            status: receipt.status,
            paymentEvent: paymentEvent // Include event for logging
          };
        } catch (error) {
          // If frontend signing fails, try backend as fallback
          const errorMessage = (error as Error).message;
          console.warn("Frontend payment signing failed, trying backend:", error);
          
          // Check if it's an insufficient funds error
          if (errorMessage.includes("insufficient funds") || errorMessage.includes("have 0 want")) {
            const agentAddress = prepareData?.agentAddress || agentInfo?.agentAddress || "unknown";
            throw new Error(
              `Payment failed: Agent address (${agentAddress}) does not have enough native token (USDC) to pay for gas. ` +
              `The agent needs native USDC in its wallet to pay transaction fees. ` +
              `Please send some native USDC to the agent address to cover gas fees. ` +
              `Alternatively, use backend signing if the agent exists in backend.`
            );
          }
          
          try {
            return await executePayment(payload);
          } catch (backendError) {
            // If backend also fails, throw original error with context
            throw new Error(
              `Payment failed: ${errorMessage}. ` +
              `Backend fallback also failed: ${(backendError as Error).message}. ` +
              `Please ensure agent private key is available or agent exists in backend.`
            );
          }
        }
      } else {
        // No agent private key in localStorage, try backend
        try {
          return await executePayment(payload);
        } catch (error) {
          // Backend doesn't have agent either
          const errorMessage = (error as any)?.response?.data?.error || (error as Error).message;
          const errorDetails = (error as any)?.response?.data?.details || "";
          
          if (errorMessage.includes("404") || errorMessage.includes("Unknown agentId") || errorMessage.includes("not found")) {
            throw new Error(
              "Payment failed: Agent private key not found.\n\n" +
              "Possible causes:\n" +
              "1. Agent was created with frontend wallet signing but localStorage was cleared\n" +
              "2. Agent was created with backend but backend was restarted (agentStore is in-memory)\n" +
              "3. Agent private key was never stored\n\n" +
              "Solutions:\n" +
              "• If agent was created with frontend: Refresh page to reload from localStorage\n" +
              "• If agent exists on contract: You need the agent private key to make payments\n" +
              "• Create a new agent if you don't have the private key\n\n" +
              `Error details: ${errorMessage}${errorDetails ? ` (${errorDetails})` : ""}`
            );
          }
          throw error;
        }
      }
    },
    onSuccess: (data: AgentPayResponse & { paymentEvent?: any }) => {
      const explorerUrl = `https://testnet.arcscan.app/tx/${data.transactionHash}`;
      const paymentEvent = (data as any).paymentEvent;
      
      let logMessage = `Payment ${formatBaseUnits(data.amount)} USDC to ${shortAddress(data.merchant)} ` +
        `(agent ${data.agentId}) | ` +
        `Hash: ${data.transactionHash} | ` +
        `View on Explorer: ${explorerUrl}`;
      
      if (paymentEvent) {
        logMessage += `\n   Verified: AgentPayment event confirmed in transaction logs`;
        logMessage += `\n   Event details: agentId=${paymentEvent.args.agentId}, merchant=${shortAddress(paymentEvent.args.merchant)}, amount=${formatBaseUnits(paymentEvent.args.amount?.toString() || data.amount)}`;
        logMessage += `\n   Note: USDC transfer is an internal transaction. Check "Token transfers" tab on explorer to see the actual USDC transfer.`;
      }
      
      appendLog(logMessage);
      setPaymentForm(initialPaymentForm);
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`Payment failed: ${(error as Error).message}`);
    }
  });

  const pauseResumeMutation = useMutation({
    mutationFn: async (active: boolean) => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = ownedAgents.find((a) => a.agentId === selectedAgentId);
      const agentOwner = agentInfo?.ownerAddress;

      // If wallet is connected and matches agent owner, use frontend signing
      if (
        wallet.isConnected &&
        wallet.address &&
        wallet.getWalletClient() &&
        agentOwner &&
        wallet.address.toLowerCase() === agentOwner.toLowerCase()
      ) {
        const walletClient = wallet.getWalletClient()!;
        const publicClient = wallet.publicClient;

        // Prepare pause/resume transaction
        const prepareData = await pauseResumeAgent({
          agentId: selectedAgentId,
          active
        });

        if (prepareData.needsSigning && prepareData.transaction) {
          // Frontend signing
          const deserializedTx = deserializeBigInt(prepareData.transaction);
          const hash = await walletClient.writeContract(deserializedTx);
          const receipt = await publicClient.waitForTransactionReceipt({ hash });

          return {
            ...prepareData,
            transactionHash: hash,
            status: receipt.status
          };
        } else if (prepareData.transactionHash) {
          // Backend already signed
          return prepareData;
        } else {
          throw new Error("Invalid response from pause/resume endpoint");
        }
      } else {
        // Backend signing (or wallet not connected)
        return pauseResumeAgent({
          agentId: selectedAgentId,
          active
        });
      }
    },
    onSuccess: (data) => {
      const action = data.active ? "resumed" : "paused";
      appendLog(
        `Agent ${selectedAgentId} ${action} (tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`Failed to pause/resume agent: ${(error as Error).message}`);
    }
  });

  const withdrawMutation = useMutation({
    mutationFn: async (amount?: string) => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = ownedAgents.find((a) => a.agentId === selectedAgentId);
      const agentOwner = agentInfo?.ownerAddress;

      const payload: { agentId: number; amount?: string } = {
        agentId: selectedAgentId
      };
      if (amount) {
        payload.amount = parseUsdToBaseUnits(amount).toString();
      }

      // If wallet is connected and matches agent owner, use frontend signing
      if (
        wallet.isConnected &&
        wallet.address &&
        wallet.getWalletClient() &&
        agentOwner &&
        wallet.address.toLowerCase() === agentOwner.toLowerCase()
      ) {
        const walletClient = wallet.getWalletClient()!;
        const publicClient = wallet.publicClient;

        // Prepare withdraw transaction
        const prepareData = await withdrawFromAgent(payload);

        if (prepareData.needsSigning && prepareData.transaction) {
          // Frontend signing
          const deserializedTx = deserializeBigInt(prepareData.transaction);
          const hash = await walletClient.writeContract(deserializedTx);
          const receipt = await publicClient.waitForTransactionReceipt({ hash });

          // Get new balance
          const newBalance = (await publicClient.readContract({
            address: AGENT_WALLET_ADDRESS,
            abi: agentWalletAbi,
            functionName: "balanceOf",
            args: [BigInt(selectedAgentId)]
          })) as bigint;

          return {
            ...prepareData,
            transactionHash: hash,
            newBalance: newBalance.toString(),
            status: receipt.status
          };
        } else if (prepareData.transactionHash) {
          // Backend already signed
          return prepareData;
        } else {
          throw new Error("Invalid response from withdraw endpoint");
        }
      } else {
        // Backend signing (or wallet not connected)
        return withdrawFromAgent(payload);
      }
    },
    onSuccess: (data) => {
      const amountText = data.amount === "all" ? "all funds" : `${formatBaseUnits(data.amount)} USDC`;
      appendLog(
        `Withdrew ${amountText} from agent ${selectedAgentId} ` +
          `(new balance: ${data.newBalance ? formatBaseUnits(data.newBalance) : "N/A"} USDC, ` +
          `tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`Failed to withdraw: ${(error as Error).message}`);
    }
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null) throw new Error("Select an agent first");
      const amount = parseUsdToBaseUnits(depositForm.amount).toString();

      // Get agent owner from details
      const agentInfo = ownedAgents.find((a) => a.agentId === selectedAgentId);
      const agentOwner = agentInfo?.ownerAddress;

      // If wallet is connected and matches agent owner, use frontend signing
      if (
        wallet.isConnected &&
        wallet.address &&
        wallet.getWalletClient() &&
        agentOwner &&
        wallet.address.toLowerCase() === agentOwner.toLowerCase()
      ) {
        const walletClient = wallet.getWalletClient()!;

        // Prepare deposit (includes approve if needed)
        const prepareData = await prepareDeposit({
          agentId: selectedAgentId,
          amount,
          ownerAddress: wallet.address
        });

        // Execute transactions in order (approve first, then deposit)
        let depositHash: `0x${string}`;
        
        // If needs approval, execute approve first and wait
        if (prepareData.needsApproval) {
          const approveTx = prepareData.transactions.find((tx) => tx.type === "approve");
          if (approveTx) {
            const approveRequest = deserializeBigInt(approveTx.transaction);
            const approveHash = await walletClient.writeContract(approveRequest as any);
            await wallet.publicClient.waitForTransactionReceipt({ hash: approveHash });
            
            // After approve, prepare deposit again
            const depositPrepare = await prepareDeposit({
              agentId: selectedAgentId,
              amount,
              ownerAddress: wallet.address
            });
            
            // Now execute deposit
            const depositTx = depositPrepare.transactions.find((tx) => tx.type === "deposit");
            if (depositTx) {
              const depositRequest = deserializeBigInt(depositTx.transaction);
              depositHash = await walletClient.writeContract(depositRequest as any);
            } else {
              throw new Error("Deposit transaction not found after approve");
            }
          } else {
            throw new Error("Approve transaction not found");
          }
        } else {
          // Allowance already sufficient, execute deposit directly
          const depositTx = prepareData.transactions.find((tx) => tx.type === "deposit");
          if (depositTx) {
            const depositRequest = deserializeBigInt(depositTx.transaction);
            depositHash = await walletClient.writeContract(depositRequest as any);
          } else {
            throw new Error("Deposit transaction not found");
          }
        }

        // Wait for deposit receipt
        const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash: depositHash! });

        // Get new balance
        const newBalance = (await wallet.publicClient.readContract({
          address: AGENT_WALLET_ADDRESS,
          abi: agentWalletAbi,
          functionName: "balanceOf",
          args: [BigInt(selectedAgentId)]
        })) as bigint;

        return {
          transactionHash: depositHash!,
          agentId: selectedAgentId,
          amount,
          newBalance: newBalance.toString(),
          status: receipt.status
        } as DepositResponse;
      } else {
        // Fallback to backend signing (legacy - only works if backend owner matches agent owner)
        return depositToAgent({
          agentId: selectedAgentId,
          amount
        });
      }
    },
    onSuccess: (data: DepositResponse) => {
      appendLog(
        `Deposited ${formatBaseUnits(data.amount)} USDC to agent ${data.agentId} ` +
          `(new balance: ${formatBaseUnits(data.newBalance)} USDC, tx ${shortHash(data.transactionHash)})`
      );
      setDepositForm(initialDepositForm);
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`Deposit failed: ${(error as Error).message}`);
    }
  });

  const handleSelectAgent = (agentId: number) => {
    setSelectedAgentId(agentId);
    // Auto-switch to dashboard tab when agent is selected
    setActiveTab("dashboard");
    // Query will auto-refetch when selectedAgentId changes
  };

  const handleRegisterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    registerMutation.mutate(registerForm);
  };

  const handleWhitelistSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    whitelistMutation.mutate();
  };

  const handlePaymentSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    payMutation.mutate();
  };

  // Mutation to fund agent address with native USDC for gas
  const fundGasMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null || !selectedAgent?.agentAddress) {
        throw new Error("Select an agent first");
      }
      if (!wallet.isConnected || !wallet.getWalletClient() || !wallet.address) {
        throw new Error("Please connect your wallet first");
      }

      const walletClient = wallet.getWalletClient()!;
      const amount = parseEther(fundGasForm.amount);

      // Send native USDC from owner wallet to agent address
      // With MetaMask custom transport, account is automatically determined from the connected wallet
      // No need to specify account parameter - viem will use the connected wallet account
      const hash = await walletClient.sendTransaction({
        to: selectedAgent.agentAddress,
        value: amount
      });

      const publicClient = wallet.publicClient;
      if (!publicClient) {
        throw new Error("Public client not available");
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, receipt };
    },
    onSuccess: (data) => {
      appendLog(
        `Funded agent address with ${fundGasForm.amount} native USDC for gas (tx ${shortHash(data.hash)})`
      );
      setFundGasForm(initialFundGasForm);
      void refetchAgentNativeBalance();
    },
    onError: (error) => {
      appendLog(`Failed to fund gas: ${(error as Error).message}`);
    }
  });

  const handleDepositSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    depositMutation.mutate();
  };

  const handleFundGasSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    fundGasMutation.mutate();
  };

  // Tab navigation state
  const [activeTab, setActiveTab] = useState<"dashboard" | "agents" | "funding" | "payments">("dashboard");

  return (
    <div className="app-container">
      <header className="header layout">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flex: 1 }}>
            <div className="ai-gif-container">
              <img 
                src="/AI.gif" 
                alt="AI Agent" 
                className="ai-gif"
                style={{ 
                  width: "60px", 
                  height: "60px", 
                  objectFit: "contain",
                  filter: "drop-shadow(0 0 10px rgba(217, 119, 6, 0.5))"
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <h1 style={{ marginBottom: "0.25rem" }}>Arc Agent Wallet</h1>
              <p className="muted" style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", margin: 0 }}>
                <span className="ai-pulse" />
                AI-Powered Autonomous Payment System
          </p>
        </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <WalletButton />
            {selectedAgentId !== null && (
              <span className="pill" style={{ background: "rgba(217, 119, 6, 0.25)", color: "#fbbf24" }}>
                Agent #{selectedAgentId}
              </span>
            )}
          </div>
        </div>
        {/* Tab Navigation in Header */}
        <div className="tabs" style={{ marginTop: "1.5rem", marginBottom: 0 }}>
          <button
            className={clsx("tab", activeTab === "dashboard" && "active")}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={clsx("tab", activeTab === "agents" && "active")}
            onClick={() => setActiveTab("agents")}
          >
            Agents
          </button>
          <button
            className={clsx("tab", activeTab === "funding" && "active")}
            onClick={() => setActiveTab("funding")}
          >
            Funding
          </button>
          <button
            className={clsx("tab", activeTab === "payments" && "active")}
            onClick={() => setActiveTab("payments")}
          >
            Payments
          </button>
        </div>
      </header>

      <main className="layout">

        {/* Dashboard Tab */}
        <div className={clsx("tab-content", activeTab === "dashboard" && "active")}>
          <div className="stack">
            {selectedAgentId !== null && (
        <section className="card">
          <h2>
                  Agent Overview{" "}
                  <button
                    className={clsx("button", "secondary")}
                    type="button"
                    onClick={() => void refetchAgentDetails()}
                    disabled={selectedAgentId === null || isFetchingAgentDetails}
                  >
                    Refresh
                  </button>
                </h2>
                {!agentDetails ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <span className="spinner" />
                    <span className="muted">Loading agent details...</span>
                  </div>
                ) : (
                  <div className="grid">
                    <div className="stack">
                      <strong>On-chain policy</strong>
                      <span className={agentDetails.policy.active ? "status-active" : "status-paused"}>
                        {agentDetails.policy.active ? "Active" : "Paused"}
                      </span>
                      <span className="muted">
                        Daily limit: {formatBaseUnits(agentDetails.policy.dailyLimit)} USDC
                      </span>
                      <span className="muted">
                        Per tx limit: {formatBaseUnits(agentDetails.policy.perTxLimit)} USDC
                      </span>
                      <span className="muted">
                        Spent today: {formatBaseUnits(agentDetails.policy.spentToday)} USDC
                      </span>
                      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                        <button
                          className={clsx("button", "secondary")}
                          type="button"
                          onClick={() => pauseResumeMutation.mutate(!agentDetails.policy.active)}
                          disabled={pauseResumeMutation.isPending}
                        >
                          {pauseResumeMutation.isPending ? (
                            <>
                              <span className="spinner" />
                              Processing...
                            </>
                          ) : agentDetails.policy.active ? (
                            <>Pause</>
                          ) : (
                            <>Resume</>
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="stack">
                      <strong>Funding</strong>
                      <span className="muted">
                        Agent balance: {formatBaseUnits(agentDetails.balance)} USDC
                      </span>
                      <span className="muted">
                        Agent native balance (gas): {agentNativeBalance !== undefined ? formatEther(agentNativeBalance) : "Loading..."} USDC
                      </span>
                      {agentNativeBalance !== undefined && agentNativeBalance === BigInt(0) && (
                        <span className="muted" style={{ color: "#d32f2f", fontSize: "0.875rem" }}>
                          Warning: Agent address has no native USDC for gas! Fund it below.
                        </span>
                      )}
                      <span className="muted">Owner: {shortAddress(agentDetails.owner)}</span>
                      <span className="muted">Agent: {shortAddress(agentDetails.agent)}</span>
                      {Number(agentDetails.balance) > 0 && (
                        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                          <button
                            className={clsx("button", "danger")}
                            type="button"
                            onClick={() => {
                              if (confirm(`Are you sure you want to emergency withdraw all ${formatBaseUnits(agentDetails.balance)} USDC from agent ${selectedAgentId}?`)) {
                                withdrawMutation.mutate();
                              }
                            }}
                            disabled={withdrawMutation.isPending}
                          >
                            {withdrawMutation.isPending ? (
                              <>
                                <span className="spinner" />
                                Withdrawing...
                              </>
                            ) : (
                              <>Emergency Withdraw All</>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="stack">
                      <strong>Backend cache</strong>
                      {agentDetails.locallyTracked ? (
                        <>
                          <span className="muted">Private key stored in relayer memory.</span>
                          <span className="muted">
                            Cached limits: daily {formatBaseUnits(agentDetails.locallyTracked.cachedDailyLimit)} /
                            per-tx {formatBaseUnits(agentDetails.locallyTracked.cachedPerTxLimit)} USDC
                          </span>
                        </>
                      ) : (
                        <span className="muted">No cached record in backend (likely created elsewhere).</span>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {selectedAgentId === null && (
              <section className="card ai-assistant-card">
                <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
                  <img src="/AI.gif" alt="AI Agent" className="ai-gif" style={{ width: "80px", height: "80px", objectFit: "contain" }} />
                  <div style={{ flex: 1 }}>
                    <h2>AI Agent Dashboard</h2>
                    <p className="muted" style={{ marginBottom: "1rem" }}>
                      Select an agent from the Agents tab to view its overview and activity.
                    </p>
                    <div className="ai-badge">
                      <span>Ready to manage your AI agents</span>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>

        {/* Agents Tab */}
        <div className={clsx("tab-content", activeTab === "agents" && "active")}>
          <div className="stack">
            <section className="card">
              <h2>
                Create AI Agent
                <span className="tag" style={{ marginLeft: "1rem" }}>
              <span className="status-dot" />
                  Deployer {shortAddress(selectedAgent?.ownerAddress ?? wallet.address ?? "0x0000000000000000000000000000000000000000")}
            </span>
          </h2>
              <p className="muted" style={{ marginBottom: "1.5rem" }}>
                Deploy a new AI agent with custom spending policies and limits.
              </p>
          <form className="grid" onSubmit={handleRegisterSubmit}>
            <div className="input-group">
              <label htmlFor="dailyLimit">Daily limit (USDC)</label>
              <input
                id="dailyLimit"
                type="text"
                placeholder="250.00"
                value={registerForm.dailyLimit}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, dailyLimit: event.target.value }))}
                required
              />
            </div>
            <div className="input-group">
              <label htmlFor="perTxLimit">Per transaction limit (USDC)</label>
              <input
                id="perTxLimit"
                type="text"
                placeholder="25.00"
                value={registerForm.perTxLimit}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, perTxLimit: event.target.value }))}
                required
              />
            </div>
            <div className="input-group" style={{ alignSelf: "flex-end" }}>
              <button className="button" type="submit" disabled={registerMutation.isPending}>
                {registerMutation.isPending ? (
                  <>
                    <span className="spinner" />
                    Creating...
                  </>
                ) : (
                  "Create Agent"
                )}
              </button>
            </div>
          </form>
          {registerMutation.isError && (
            <div className="alert error">
              <div>
                <strong>Error creating agent:</strong>
                <p style={{ margin: "0.25rem 0 0 0" }}>{(registerMutation.error as Error)?.message ?? "Unknown error"}</p>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <h2>
            Registered Agents
            {ownedAgents.length > 0 && (
              <span className="ai-badge" style={{ marginLeft: "1rem", fontSize: "0.75rem" }}>
                {ownedAgents.length} active
              </span>
            )}
          </h2>
          {!wallet.isConnected ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <img src="/AI.gif" alt="AI Agent" className="ai-gif-large" style={{ marginBottom: "1rem" }} />
              <p className="muted">Please connect your wallet to view your agents.</p>
            </div>
          ) : ownedAgents.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <img src="/AI.gif" alt="AI Agent" className="ai-gif-large" style={{ marginBottom: "1rem" }} />
            <p className="muted">No agents created yet. Deploy one to get started.</p>
            </div>
          ) : (
            <div className="stack">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Agent Address</th>
                    <th>Owner</th>
                    <th>Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {ownedAgents.map((agent) => (
                    <tr key={agent.agentId}>
                      <td>#{agent.agentId}</td>
                      <td>{shortAddress(agent.agentAddress)}</td>
                      <td>{shortAddress(agent.ownerAddress)}</td>
                      <td>
                        <button
                          type="button"
                          className={clsx("button", "secondary")}
                          onClick={() => handleSelectAgent(agent.agentId)}
                        >
                          {selectedAgentId === agent.agentId ? "Selected" : "Manage"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selectedAgent && (
                <div className="stack" style={{ marginTop: "1.5rem", padding: "1.5rem", background: "rgba(217, 119, 6, 0.1)", border: "1px solid rgba(217, 119, 6, 0.2)", borderRadius: "12px" }}>
                  <div>
                    <strong style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
                      Agent Private Key
                    </strong>
                    <div className="alert warning" style={{ marginBottom: "1rem", background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.3)" }}>
                      <div>
                        <strong style={{ color: "#f59e0b" }}>Security Warning</strong>
                        <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.875rem" }}>
                          This private key is stored in your browser's localStorage in plain text. This is NOT secure for production use.
                          Anyone with access to your computer or malicious scripts can steal this key. Only use this for testing on testnet.
                        </p>
                      </div>
                    </div>
                    {selectedAgent.privateKey ? (
                      <>
                        <div className="alert success" style={{ marginBottom: "1rem" }}>
                          <div>
                            <strong>Private key found!</strong>
                            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.875rem" }}>
                              Store this securely offline! You need it to make payments. If you lose it, you cannot recover it.
                              <strong style={{ color: "#ef4444", display: "block", marginTop: "0.5rem" }}>
                                DO NOT share this key or use it on untrusted devices.
                              </strong>
                            </p>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
                          <code style={{ 
                            wordBreak: "break-all", 
                            fontFamily: "monospace", 
                            fontSize: "0.875rem", 
                            padding: "0.75rem", 
                            background: "rgba(28, 25, 23, 0.8)",
                            border: "1px solid var(--border-color)",
                            borderRadius: "8px",
                            flex: 1,
                            margin: 0
                          }}>
                            {selectedAgent.encrypted 
                              ? "[ENCRYPTED - Enter password when making payments]"
                              : selectedAgent.privateKey
                            }
                          </code>
                          <button
                            type="button"
                            className="copy-button"
                            onClick={async () => {
                              if (selectedAgent.encrypted && isEncrypted(selectedAgent.privateKey)) {
                                const password = await showPasswordModal(
                                  "Decrypt Private Key",
                                  "Enter password to decrypt and copy private key."
                                );
                                if (!password) {
                                  appendLog("Password required to decrypt private key.");
                                  return;
                                }
                                try {
                                  const decrypted = await decryptPrivateKey(selectedAgent.privateKey, password);
                                  navigator.clipboard.writeText(decrypted);
                                  appendLog("Private key decrypted and copied to clipboard!");
                                } catch (error) {
                                  appendLog(`Failed to decrypt: ${(error as Error).message}`);
                                }
                              } else {
                                navigator.clipboard.writeText(selectedAgent.privateKey);
                                appendLog("Private key copied to clipboard!");
                              }
                            }}
                          >
                            {selectedAgent.encrypted ? "Decrypt & Copy" : "Copy"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="alert error">
                        <div>
                          <strong>Private key not found!</strong>
                          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.875rem" }}>
                            This agent was likely created with backend signing (legacy) or the private key was lost. 
                            You need to create a new agent with wallet signing to get a private key.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
                    <div>
                      <strong style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>Agent Address</strong>
                      <p style={{ fontFamily: "monospace", fontSize: "0.875rem", margin: "0.25rem 0 0 0", wordBreak: "break-all" }}>
                        {selectedAgent.agentAddress}
                      </p>
                    </div>
                    <div>
                      <strong style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>Creation Transaction</strong>
                      <p style={{ margin: "0.25rem 0 0 0" }}>
                    <a
                      href={`https://testnet.arcscan.app/tx/${selectedAgent.transactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                          style={{ color: "#d97706", textDecoration: "underline" }}
                    >
                          {shortHash(selectedAgent.transactionHash)} ↗
                    </a>
                  </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
          </div>
        </div>

        {/* Funding Tab */}
        <div className={clsx("tab-content", activeTab === "funding" && "active")}>
          <div className="stack">
          {selectedAgentId === null ? (
              <section className="card">
                <h2>Funding</h2>
                <p className="muted">Please select an agent from the Agents tab first.</p>
              </section>
            ) : (
              <section className="card">
                <h2>Deposit / Withdraw USDC</h2>
          <div className="grid" style={{ marginBottom: "1rem" }}>
            <div>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Deposit</h3>
              <form className="grid" onSubmit={handleDepositSubmit}>
                <div className="input-group">
                  <label htmlFor="depositAmount">Amount (USDC)</label>
                  <input
                    id="depositAmount"
                    type="text"
                    placeholder="10.00"
                    value={depositForm.amount}
                    onChange={(event) => setDepositForm((prev) => ({ ...prev, amount: event.target.value }))}
                    required
                  />
              </div>
                <div className="input-group" style={{ alignSelf: "flex-end" }}>
                  <button
                    className="button"
                    type="submit"
                    disabled={selectedAgentId === null || depositMutation.isPending}
                  >
                    {depositMutation.isPending ? (
                      <>
                        <span className="spinner" />
                        Depositing...
                  </>
                ) : (
                      "Deposit"
                    )}
                  </button>
                </div>
              </form>
              {depositMutation.isError && (
                <div className="alert error" style={{ marginTop: "1rem" }}>
                  <div>
                    <strong>Deposit failed:</strong>
                    <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.875rem" }}>
                      {(depositMutation.error as Error)?.message ?? "Unknown error"}
                    </p>
              </div>
            </div>
          )}
            </div>
            <div>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Fund Gas (Native USDC)</h3>
              <p className="muted" style={{ fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                Agent address needs native USDC in its wallet to pay for transaction gas fees. 
                This is separate from the USDC balance in the contract.
              </p>
              <form className="grid" onSubmit={handleFundGasSubmit}>
                <div className="input-group">
                  <label htmlFor="fundGasAmount">Amount (Native USDC)</label>
                  <input
                    id="fundGasAmount"
                    type="text"
                    placeholder="0.01"
                    value={fundGasForm.amount}
                    onChange={(event) => setFundGasForm((prev) => ({ ...prev, amount: event.target.value }))}
                    required
                  />
                </div>
                <div className="input-group" style={{ alignSelf: "flex-end" }}>
                  <button
                    className="button"
                    type="submit"
                    disabled={selectedAgentId === null || fundGasMutation.isPending || !wallet.isConnected}
                  >
                    {fundGasMutation.isPending ? "Funding..." : "Fund Gas"}
                  </button>
                </div>
              </form>
              {fundGasMutation.isError && (
                <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  Error: {(fundGasMutation.error as Error)?.message ?? "Unknown error"}
                </p>
              )}
            </div>
            <div>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Withdraw</h3>
              <form
                className="grid"
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const amount = (formData.get("withdrawAmount") as string) || undefined;
                  withdrawMutation.mutate(amount);
                }}
              >
                <div className="input-group">
                  <label htmlFor="withdrawAmount">Amount (USDC) - Leave empty for emergency withdraw</label>
                  <input
                    id="withdrawAmount"
                    name="withdrawAmount"
                    type="text"
                    placeholder="10.00 or empty for all"
                  />
                </div>
                <div className="input-group" style={{ alignSelf: "flex-end" }}>
                  <button
                    className="button"
                    type="submit"
                    disabled={selectedAgentId === null || withdrawMutation.isPending}
                  >
                    {withdrawMutation.isPending ? "Withdrawing..." : "Withdraw"}
                  </button>
                </div>
              </form>
              {withdrawMutation.isError && (
                <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  Error: {(withdrawMutation.error as Error)?.message ?? "Unknown error"}
                </p>
              )}
            </div>
          </div>
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Note: Deposit will approve USDC (if needed) and deposit to the selected agent wallet. Withdraw will
            transfer USDC from agent wallet back to owner. Leave withdraw amount empty to withdraw all funds
            (emergency withdraw).
          </p>
        </section>
            )}
          </div>
        </div>

        {/* Payments Tab */}
        <div className={clsx("tab-content", activeTab === "payments" && "active")}>
          <div className="stack">
            {selectedAgentId === null ? (
              <section className="card">
                <h2>Payments</h2>
                <p className="muted">Please select an agent from the Agents tab first.</p>
              </section>
            ) : (
              <>
        <section className="card">
          <h2>Merchant Whitelist</h2>
          <form className="grid" onSubmit={handleWhitelistSubmit}>
            <div className="input-group">
              <label htmlFor="whitelistMerchant">Merchant address</label>
              <input
                id="whitelistMerchant"
                type="text"
                placeholder="0x..."
                value={whitelistMerchantAddress}
                onChange={(event) => setWhitelistMerchantAddress(event.target.value)}
                required
              />
            </div>
            <div className="input-group">
              <label htmlFor="whitelistAllowed">Status</label>
              <select
                id="whitelistAllowed"
                value={whitelistAllowed ? "true" : "false"}
                onChange={(event) => setWhitelistAllowed(event.target.value === "true")}
              >
                <option value="true">Allow payments</option>
                <option value="false">Remove access</option>
              </select>
            </div>
            <div className="input-group" style={{ alignSelf: "flex-end" }}>
              <button
                className="button"
                type="submit"
                disabled={selectedAgentId === null || whitelistMutation.isPending}
              >
                {whitelistMutation.isPending ? "Updating..." : "Update whitelist"}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>Execute Payment</h2>
          <form className="grid" onSubmit={handlePaymentSubmit}>
            <div className="input-group">
              <label htmlFor="payMerchant">Merchant address</label>
              <input
                id="payMerchant"
                type="text"
                placeholder="0x..."
                value={paymentForm.merchant}
                onChange={(event) => setPaymentForm((prev) => ({ ...prev, merchant: event.target.value }))}
                required
              />
            </div>
            <div className="input-group">
              <label htmlFor="payAmount">Amount (USDC)</label>
              <input
                id="payAmount"
                type="text"
                placeholder="1.00"
                value={paymentForm.amount}
                onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))}
                required
              />
            </div>
            <div className="input-group">
              <label htmlFor="payData">Call data (hex, optional)</label>
              <textarea
                id="payData"
                placeholder="0x..."
                value={paymentForm.data}
                onChange={(event) => setPaymentForm((prev) => ({ ...prev, data: event.target.value }))}
              />
            </div>
            <div className="input-group" style={{ alignSelf: "flex-end" }}>
              <button className="button" type="submit" disabled={selectedAgentId === null || payMutation.isPending}>
                {payMutation.isPending ? "Sending..." : "Send payment"}
              </button>
            </div>
          </form>
        </section>
              </>
            )}
                </div>
            </div>

        {/* Activity Log - Visible on all tabs, at the bottom */}
        <section className="card">
          <h2>
            Activity Log
            {logs.length > 0 && (
              <span className="ai-badge" style={{ marginLeft: "1rem", fontSize: "0.75rem" }}>
                {logs.length} events
              </span>
            )}
          </h2>
          {logs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <img src="/AI.gif" alt="AI Agent" className="ai-gif-large" style={{ marginBottom: "1rem" }} />
              <p className="muted">AI agent activities will appear here</p>
            </div>
          ) : (
            <div className="log">
              {logs.map((entry) => (
                <div key={entry.id} className="log-entry">
                  {entry.message}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      
      {/* Password Modal */}
      {passwordModal.open && (
        <div 
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
            backdropFilter: "blur(4px)"
          }}
          onClick={handlePasswordCancel}
        >
          <div 
            className="card"
            style={{
              maxWidth: "500px",
              width: "90%",
              margin: "1rem",
              position: "relative"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0 }}>{passwordModal.title}</h2>
            <p className="muted" style={{ marginBottom: "1.5rem" }}>
              {passwordModal.message}
            </p>
            <div className="input-group">
              <label htmlFor="passwordInput">Password</label>
              <input
                id="passwordInput"
                type="password"
                placeholder="Enter password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyPress={handlePasswordKeyPress}
                autoFocus
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
              <button
                className="button secondary"
                type="button"
                onClick={handlePasswordCancel}
              >
                Cancel
              </button>
              <button
                className="button"
                type="button"
                onClick={handlePasswordConfirm}
                disabled={passwordInput.length === 0}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function shortAddress(address: string) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string) {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export default App;


