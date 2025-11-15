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
  privateKey: `0x${string}`;
  transactionHash: `0x${string}`;
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

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId]
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
    onSuccess: (data) => {
      const agentId = Number(data.agentId);
      
      // Verify private key exists
      if (!data.agentPrivateKey) {
        console.error("Agent created but private key is missing!", data);
        appendLog(`⚠️ Agent ${agentId} created but private key is missing! This agent cannot make payments.`);
      }
      
      const newAgent = {
          agentId,
          agentAddress: data.agentAddress,
          ownerAddress: data.ownerAddress,
        privateKey: data.agentPrivateKey || "" as `0x${string}`, // Fallback to empty string if missing
          transactionHash: data.transactionHash
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
        `🆕 Agent ${agentId} created → address ${data.agentAddress}, tx ${shortHash(data.transactionHash)}`
      );
      if (data.agentPrivateKey) {
        appendLog(
          `🔑 Agent Private Key: ${data.agentPrivateKey} (IMPORTANT: Store this securely! You need it for payments.)`
        );
      } else {
        appendLog(
          `⚠️ WARNING: Agent private key is missing! This agent cannot make payments.`
        );
      }
      setRegisterForm(initialRegisterForm);
    },
    onError: (error) => {
      appendLog(`❌ Failed to create agent: ${(error as Error).message}`);
    }
  });

  const whitelistMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = agents.find((a) => a.agentId === selectedAgentId);
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
        `✅ Merchant ${shortAddress(whitelistMerchantAddress)} ${
          whitelistAllowed ? "whitelisted" : "removed"
        } for agent ${selectedAgentId} (tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      setWhitelistMerchantAddress("");
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`❌ Failed to update whitelist: ${(error as Error).message}`);
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
      const agentInfo = agents.find((a) => a.agentId === selectedAgentId);
      const agentPrivateKey = agentInfo?.privateKey;

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
                console.log("✅ AgentPayment event found:", {
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
              `❌ Payment failed: Agent address (${agentAddress}) does not have enough native token (USDC) to pay for gas. ` +
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
              "❌ Payment failed: Agent private key not found.\n\n" +
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
      
      let logMessage = `💸 Payment ${formatBaseUnits(data.amount)} USDC to ${shortAddress(data.merchant)} ` +
        `(agent ${data.agentId}) | ` +
        `Hash: ${data.transactionHash} | ` +
        `🔗 View on Explorer: ${explorerUrl}`;
      
      if (paymentEvent) {
        logMessage += `\n   ✅ Verified: AgentPayment event confirmed in transaction logs`;
        logMessage += `\n   📋 Event details: agentId=${paymentEvent.args.agentId}, merchant=${shortAddress(paymentEvent.args.merchant)}, amount=${formatBaseUnits(paymentEvent.args.amount?.toString() || data.amount)}`;
        logMessage += `\n   💡 Note: USDC transfer is an internal transaction. Check "Token transfers" tab on explorer to see the actual USDC transfer.`;
      }
      
      appendLog(logMessage);
      setPaymentForm(initialPaymentForm);
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`❌ Payment failed: ${(error as Error).message}`);
    }
  });

  const pauseResumeMutation = useMutation({
    mutationFn: async (active: boolean) => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = agents.find((a) => a.agentId === selectedAgentId);
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
        `⏸️ Agent ${selectedAgentId} ${action} (tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`❌ Failed to pause/resume agent: ${(error as Error).message}`);
    }
  });

  const withdrawMutation = useMutation({
    mutationFn: async (amount?: string) => {
      if (selectedAgentId === null) throw new Error("Select an agent first");

      // Get agent owner from details
      const agentInfo = agents.find((a) => a.agentId === selectedAgentId);
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
        `💰 Withdrew ${amountText} from agent ${selectedAgentId} ` +
          `(new balance: ${data.newBalance ? formatBaseUnits(data.newBalance) : "N/A"} USDC, ` +
          `tx ${data.transactionHash ? shortHash(data.transactionHash) : "pending"})`
      );
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`❌ Failed to withdraw: ${(error as Error).message}`);
    }
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (selectedAgentId === null) throw new Error("Select an agent first");
      const amount = parseUsdToBaseUnits(depositForm.amount).toString();

      // Get agent owner from details
      const agentInfo = agents.find((a) => a.agentId === selectedAgentId);
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
        `💰 Deposited ${formatBaseUnits(data.amount)} USDC to agent ${data.agentId} ` +
          `(new balance: ${formatBaseUnits(data.newBalance)} USDC, tx ${shortHash(data.transactionHash)})`
      );
      setDepositForm(initialDepositForm);
      void refetchAgentDetails();
    },
    onError: (error) => {
      appendLog(`❌ Deposit failed: ${(error as Error).message}`);
    }
  });

  const handleSelectAgent = (agentId: number) => {
    setSelectedAgentId(agentId);
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
        `✅ Funded agent address with ${fundGasForm.amount} native USDC for gas (tx ${shortHash(data.hash)})`
      );
      setFundGasForm(initialFundGasForm);
      void refetchAgentNativeBalance();
    },
    onError: (error) => {
      appendLog(`❌ Failed to fund gas: ${(error as Error).message}`);
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

  return (
    <div className="app-container">
      <header className="header layout">
        <div>
          <h1>Arc Agent Wallet Sandbox</h1>
          <p className="muted">
            Deploy, fund, and monitor sandbox AI agents with policy-enforced spending on Arc Testnet.
          </p>
        </div>
        <div className="stack" style={{ alignItems: "flex-end" }}>
          <WalletButton />
          <span className="pill">Port: 5173 (proxy to backend)</span>
          <span className="pill">Selected agent: {selectedAgentId ?? "—"}</span>
        </div>
      </header>

      <main className="layout stack">
        <section className="card">
          <h2>
            Create Agent
            <span className="tag">
              <span className="status-dot" />
              Deployer {shortAddress(selectedAgent?.ownerAddress ?? "0x0000000000000000000000000000000000000000")}
            </span>
          </h2>
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
                {registerMutation.isPending ? "Creating..." : "Create Agent"}
              </button>
            </div>
          </form>
          {registerMutation.isError && (
            <p className="muted">Error: {(registerMutation.error as Error)?.message ?? "Unknown error"}</p>
          )}
        </section>

        <section className="card">
          <h2>Registered Agents</h2>
          {agents.length === 0 ? (
            <p className="muted">No agents created yet. Deploy one to get started.</p>
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
                  {agents.map((agent) => (
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
                <div className="stack" style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                  <div>
                    <strong style={{ color: "#d32f2f" }}>⚠️ IMPORTANT: Agent Private Key</strong>
                    {selectedAgent.privateKey ? (
                      <>
                        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <p style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: "0.875rem", margin: 0, flex: 1 }}>
                            {selectedAgent.privateKey}
                          </p>
                          <button
                            type="button"
                            className="button secondary"
                            style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                            onClick={() => {
                              navigator.clipboard.writeText(selectedAgent.privateKey);
                              appendLog("✅ Private key copied to clipboard!");
                            }}
                          >
                            Copy
                          </button>
                        </div>
                        <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                          ✅ Private key found! Store this securely! You need it to make payments. If you lose it, you cannot recover it.
                        </p>
                      </>
                    ) : (
                      <>
                        <p style={{ marginTop: "0.5rem", wordBreak: "break-all", fontFamily: "monospace", fontSize: "0.875rem", color: "#d32f2f" }}>
                          ❌ Private key not found!
                        </p>
                        <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                          This agent was likely created with backend signing (legacy) or the private key was lost. 
                          You need to create a new agent with wallet signing to get a private key.
                        </p>
                      </>
                    )}
                  </div>
                  <div>
                    <strong>Agent Address:</strong>
                    <p style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{selectedAgent.agentAddress}</p>
                  </div>
                  <div>
                    <strong>Creation Transaction:</strong>
                  <p className="muted">
                    <a
                      href={`https://testnet.arcscan.app/tx/${selectedAgent.transactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                        {shortHash(selectedAgent.transactionHash)}
                    </a>
                  </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

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
          {selectedAgentId === null ? (
            <p className="muted">Select an agent to inspect policy, balance, and spend.</p>
          ) : !agentDetails ? (
            <p className="muted">Loading agent details...</p>
          ) : (
            <div className="grid">
              <div className="stack">
                <strong>On-chain policy</strong>
                <span className="muted">Status: {agentDetails.policy.active ? "Active" : "Paused"}</span>
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
                    {pauseResumeMutation.isPending
                      ? "..."
                      : agentDetails.policy.active
                        ? "⏸️ Pause"
                        : "▶️ Resume"}
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
                    ⚠️ Agent address has no native USDC for gas! Fund it below.
                  </span>
                )}
                <span className="muted">Owner: {shortAddress(agentDetails.owner)}</span>
                <span className="muted">Agent: {shortAddress(agentDetails.agent)}</span>
                {Number(agentDetails.balance) > 0 && (
                  <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      className={clsx("button", "secondary")}
                      type="button"
                      onClick={() => withdrawMutation.mutate()}
                      disabled={withdrawMutation.isPending}
                    >
                      {withdrawMutation.isPending ? "..." : "🚨 Emergency Withdraw All"}
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
                    {depositMutation.isPending ? "Depositing..." : "Deposit"}
                  </button>
                </div>
              </form>
              {depositMutation.isError && (
                <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  Error: {(depositMutation.error as Error)?.message ?? "Unknown error"}
                </p>
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

        <section className="card">
          <h2>Activity Log</h2>
          {logs.length === 0 ? (
            <p className="muted">Everything you do in this dashboard will show up here.</p>
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


