import express from "express";
import pino from "pino";
import {
  Chain,
  Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { agentWalletAbi } from "./abi/agentWalletAbi";
import { env } from "./config";

// ERC20 ABI for approve
const erc20Abi = [
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  }
] as const;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined
});

const arcChain: Chain = {
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [env.ARC_RPC_URL] },
    public: { http: [env.ARC_RPC_URL] }
  }
};

const transport = http(env.ARC_RPC_URL);
const publicClient = createPublicClient({ chain: arcChain, transport });

const ownerAccount = privateKeyToAccount(env.OWNER_PRIVATE_KEY as Hex);
const ownerClient = createWalletClient({
  chain: arcChain,
  transport,
  account: ownerAccount
});

type AgentAccount = ReturnType<typeof privateKeyToAccount>;
type AgentRecord = {
  agentId: bigint;
  account: AgentAccount;
  privateKey: Hex;
  owner: Hex;
  dailyLimit: bigint;
  perTxLimit: bigint;
};

const agentStore = new Map<number, AgentRecord>();

// Helper to serialize BigInt recursively
function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === "bigint") {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }
  if (typeof obj === "object") {
    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = serializeBigInt(obj[key]);
      }
    }
    return result;
  }
  return obj;
}

const amountSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform<bigint>((value) => {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Amount must be finite");
      return BigInt(Math.trunc(value));
    }
    const trimmed = value.trim();
    return trimmed.startsWith("0x") ? BigInt(trimmed) : BigInt(trimmed);
  });

const registerSchema = z.object({
  dailyLimit: amountSchema,
  perTxLimit: amountSchema
});

const whitelistSchema = z.object({
  agentId: z.coerce.number().int().nonnegative(),
  merchant: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "merchant must be a valid 0x-prefixed address"),
  allowed: z.boolean()
});

const paySchema = z.object({
  agentId: z.coerce.number().int().nonnegative(),
  merchant: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "merchant must be a valid 0x-prefixed address"),
  amount: amountSchema,
  data: z
    .string()
    .regex(/^0x[a-fA-F0-9]*$/, "data must be a hex string")
    .default("0x")
    .optional()
});

const depositSchema = z.object({
  agentId: z.coerce.number().int().nonnegative(),
  amount: amountSchema
});

const pauseResumeSchema = z.object({
  agentId: z.coerce.number().int().nonnegative(),
  active: z.boolean()
});

const withdrawSchema = z.object({
  agentId: z.coerce.number().int().nonnegative(),
  amount: amountSchema.optional() // If not provided, do emergency withdraw
});

const app = express();

// CORS middleware - must be before express.json()
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Allow all origins in development
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", chainId: arcChain.id, agentCount: agentStore.size });
});

// New endpoint: Prepare agent creation (frontend will sign)
app.post("/register-agent/prepare", async (req, res, next) => {
  try {
    const { dailyLimit, perTxLimit, ownerAddress } = z
      .object({
        dailyLimit: amountSchema,
        perTxLimit: amountSchema,
        ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address").optional()
      })
      .parse(req.body);

    const agentPrivateKey = generatePrivateKey();
    const agentAccount = privateKeyToAccount(agentPrivateKey);

    // Simulate with the provided owner address or use default
    const account = ownerAddress ? (ownerAddress as Hex) : ownerAccount.address;

    const { request } = await publicClient.simulateContract({
      account: account as Hex,
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "createAgent",
      args: [agentAccount.address, dailyLimit, perTxLimit]
    });

    // Convert BigInt to string for JSON serialization (recursive)
    const serializedRequest = serializeBigInt(request);

    res.json({
      agentPrivateKey,
      agentAddress: agentAccount.address,
      transaction: serializedRequest
    });
  } catch (error) {
    next(error);
  }
});

// Endpoint: Register agent after frontend signed (for tracking)
app.post("/register-agent/complete", async (req, res, next) => {
  try {
    const { agentId, agentPrivateKey, agentAddress, ownerAddress, dailyLimit, perTxLimit, transactionHash } = z
      .object({
        agentId: z.coerce.number().int().nonnegative(),
        agentPrivateKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        agentAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        dailyLimit: amountSchema,
        perTxLimit: amountSchema,
        transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/)
      })
      .parse(req.body);

    const agentAccount = privateKeyToAccount(agentPrivateKey as Hex);

    agentStore.set(agentId, {
      agentId: BigInt(agentId),
      account: agentAccount,
      privateKey: agentPrivateKey as Hex,
      owner: ownerAddress as Hex,
      dailyLimit: BigInt(dailyLimit),
      perTxLimit: BigInt(perTxLimit)
    });

    res.json({
      agentId: agentId.toString(),
      agentAddress,
      ownerAddress,
      transactionHash
    });
  } catch (error) {
    next(error);
  }
});

// Legacy endpoint: Backend signs (for backward compatibility)
app.post("/register-agent", async (req, res, next) => {
  try {
    const { dailyLimit, perTxLimit } = registerSchema.parse(req.body);

    const agentPrivateKey = generatePrivateKey();
    const agentAccount = privateKeyToAccount(agentPrivateKey);

    const { request } = await publicClient.simulateContract({
      account: ownerAccount,
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "createAgent",
      args: [agentAccount.address, dailyLimit, perTxLimit]
    });

    const hash = await ownerClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

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
      throw new Error("Failed to find AgentCreated event in transaction logs");
    }

    agentStore.set(Number(agentId), {
      agentId,
      account: agentAccount,
      privateKey: agentPrivateKey,
      owner: ownerAccount.address,
      dailyLimit,
      perTxLimit
    });

    res.json({
      agentId: agentId.toString(),
      agentAddress: agentAccount.address,
      agentPrivateKey,
      ownerAddress: ownerAccount.address,
      transactionHash: hash
    });
  } catch (error) {
    next(error);
  }
});

// Prepare whitelist transaction (for frontend signing)
app.post("/agent/whitelist/prepare", async (req, res, next) => {
  try {
    const { agentId, merchant, allowed } = whitelistSchema.parse(req.body);

    // Get agent owner from contract
    const config = await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "agent",
      args: [BigInt(agentId)]
    });

    const agentOwner = (config as { owner: Hex }).owner;

    // Check if caller is owner (for wallet-based signing, this will be checked on-chain)
    // For backend signing, check if backend owner matches
    const useBackendSigning = agentOwner.toLowerCase() === ownerAccount.address.toLowerCase();

    if (useBackendSigning) {
      // Backend signs
      const { request } = await publicClient.simulateContract({
        account: ownerAccount,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "setMerchantWhitelist",
        args: [BigInt(agentId), merchant as Hex, allowed]
      });

      const hash = await ownerClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });

      res.json({ transactionHash: hash, agentId, merchant, allowed });
    } else {
      // Prepare for frontend signing
      const { request } = await publicClient.simulateContract({
        account: agentOwner,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "setMerchantWhitelist",
        args: [BigInt(agentId), merchant as Hex, allowed]
      });

      res.json({
        transaction: serializeBigInt(request),
        agentId,
        merchant,
        allowed,
        needsSigning: true
      });
    }
  } catch (error) {
    next(error);
  }
});

// Legacy endpoint: Backend signs (for backward compatibility)
app.post("/agent/whitelist", async (req, res, next) => {
  try {
    const { agentId, merchant, allowed } = whitelistSchema.parse(req.body);

    const { request } = await publicClient.simulateContract({
      account: ownerAccount,
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "setMerchantWhitelist",
      args: [BigInt(agentId), merchant as Hex, allowed]
    });

    const hash = await ownerClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });

    res.json({ transactionHash: hash, agentId, merchant, allowed });
  } catch (error) {
    next(error);
  }
});

// Prepare payment transaction (for frontend signing)
app.post("/agent/pay/prepare", async (req, res, next) => {
  try {
    const parsed = paySchema.parse(req.body);
    const { agentId, merchant, amount } = parsed;
    const data = parsed.data ?? "0x";

    // Get agent address from contract
    const config = await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "agent",
      args: [BigInt(agentId)]
    });

    const agentAddress = (config as { agent: Hex }).agent;

    // Simulate transaction with agent address
    const { request } = await publicClient.simulateContract({
      account: agentAddress,
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "pay",
      args: [BigInt(agentId), merchant as Hex, amount, data as Hex]
    });

    res.json({
      transaction: serializeBigInt(request),
      agentId,
      merchant,
      amount: amount.toString(),
      agentAddress,
      needsSigning: true
    });
  } catch (error) {
    next(error);
  }
});

// Legacy endpoint: Backend signs using agent private key (for backward compatibility)
app.post("/agent/pay", async (req, res, next) => {
  try {
    const parsed = paySchema.parse(req.body);
    const { agentId, merchant, amount } = parsed;
    const data = parsed.data ?? "0x";

    const record = agentStore.get(agentId);
    if (!record) {
      res.status(404).json({ error: "Unknown agentId" });
      return;
    }

    const agentClient = createWalletClient({
      chain: arcChain,
      transport,
      account: record.account
    });

    // Verify agent address matches
    const agentAddress = (agentConfig as { agent: Hex }).agent;
    if (record.account.address.toLowerCase() !== agentAddress.toLowerCase()) {
      res.status(400).json({ 
        error: "Agent address mismatch. Private key does not match agent address on contract."
      });
      return;
    }

    const { request } = await publicClient.simulateContract({
      account: record.account,
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "pay",
      args: [BigInt(agentId), merchant as Hex, amount, data as Hex]
    });

    const hash = await agentClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    res.json({
      transactionHash: hash,
      agentId,
      merchant,
      amount: amount.toString(),
      status: receipt.status
    });
  } catch (error) {
    next(error);
  }
});

// Prepare deposit transaction (for frontend signing)
app.post("/agent/deposit/prepare", async (req, res, next) => {
  try {
    const { agentId, amount, ownerAddress } = z
      .object({
        agentId: z.coerce.number().int().nonnegative(),
        amount: amountSchema,
        ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
      })
      .parse(req.body);

    logger.info({ agentId, amount: amount.toString(), ownerAddress }, "Prepare deposit request");

    // Check if agent exists
    let config;
    try {
      config = await publicClient.readContract({
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "agent",
        args: [BigInt(agentId)]
      });
    } catch (error) {
      res.status(404).json({ error: "Agent not found", details: (error as Error).message });
      return;
    }

    const agentOwner = (config as { owner: Hex }).owner;
    if (agentOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
      res.status(403).json({
        error: "Not authorized",
        details: `Agent owner is ${agentOwner}, but provided owner is ${ownerAddress}`
      });
      return;
    }

    // Check allowance
    const currentAllowance = (await publicClient.readContract({
      address: env.USDC_ADDRESS as Hex,
      abi: erc20Abi,
      functionName: "allowance",
      args: [ownerAddress as Hex, env.AGENT_WALLET_ADDRESS as Hex]
    })) as bigint;

    logger.info(
      { currentAllowance: currentAllowance.toString(), amount: amount.toString() },
      "Checking allowance for deposit"
    );

    const transactions: any[] = [];

    // If need to approve, only return approve transaction
    // Frontend will need to call prepare again after approve is confirmed
    if (currentAllowance < amount) {
      const approveAmount = amount * BigInt(2);
      try {
        const { request: approveRequest } = await publicClient.simulateContract({
          account: ownerAddress as Hex,
          address: env.USDC_ADDRESS as Hex,
          abi: erc20Abi,
          functionName: "approve",
          args: [env.AGENT_WALLET_ADDRESS as Hex, approveAmount]
        });
        transactions.push({
          type: "approve",
          transaction: serializeBigInt(approveRequest),
          needsApproval: true
        });
        // Don't prepare deposit yet - need to approve first
        res.json({ transactions, needsApproval: true });
        return;
      } catch (error) {
        logger.error({ error }, "Failed to prepare approve transaction");
        res.status(500).json({ error: "Failed to prepare approve", details: (error as Error).message });
        return;
      }
    }

    // If allowance is sufficient, prepare deposit transaction
    try {
      const { request: depositRequest } = await publicClient.simulateContract({
        account: ownerAddress as Hex,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "deposit",
        args: [BigInt(agentId), amount]
      });

      transactions.push({
        type: "deposit",
        transaction: serializeBigInt(depositRequest)
      });

      res.json({ transactions, needsApproval: false });
    } catch (error) {
      logger.error({ error }, "Failed to prepare deposit transaction");
      res.status(500).json({ error: "Failed to prepare deposit", details: (error as Error).message });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/agent/deposit", async (req, res, next) => {
  try {
    const { agentId, amount } = depositSchema.parse(req.body);
    logger.info({ agentId, amount: amount.toString() }, "Deposit request received");

    // Check if agent exists
    let config;
    try {
      config = await publicClient.readContract({
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "agent",
        args: [BigInt(agentId)]
      });
    } catch (error) {
      logger.error({ error, agentId }, "Failed to read agent config");
      res.status(404).json({ error: "Agent not found", details: (error as Error).message });
      return;
    }

    if (!config || (config as { owner: Hex }).owner === "0x0000000000000000000000000000000000000000") {
      logger.warn({ agentId }, "Agent not found");
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Check current allowance
    let currentAllowance: bigint;
    try {
      currentAllowance = (await publicClient.readContract({
        address: env.USDC_ADDRESS as Hex,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ownerAccount.address, env.AGENT_WALLET_ADDRESS as Hex]
      })) as bigint;
      logger.info({ currentAllowance: currentAllowance.toString(), amount: amount.toString() }, "Current allowance");
    } catch (error) {
      logger.error({ error }, "Failed to check allowance");
      res.status(500).json({ error: "Failed to check USDC allowance", details: (error as Error).message });
      return;
    }

    // Approve if needed (approve more than needed to avoid multiple approvals)
    if (currentAllowance < amount) {
      const approveAmount = amount * BigInt(2); // Approve 2x to reduce future approvals
      logger.info({ approveAmount: approveAmount.toString() }, "Approving USDC");
      
      try {
        const { request: approveRequest } = await publicClient.simulateContract({
          account: ownerAccount,
          address: env.USDC_ADDRESS as Hex,
          abi: erc20Abi,
          functionName: "approve",
          args: [env.AGENT_WALLET_ADDRESS as Hex, approveAmount]
        });

        const approveHash = await ownerClient.writeContract(approveRequest);
        logger.info({ approveHash }, "Approve transaction sent");
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        logger.info({ approveHash }, "Approve transaction confirmed");
      } catch (error) {
        logger.error({ error }, "Failed to approve USDC");
        res.status(500).json({ error: "Failed to approve USDC", details: (error as Error).message });
        return;
      }
    }

    // Check if owner account matches agent owner
    const agentOwner = (config as { owner: Hex }).owner;
    if (agentOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
      logger.warn(
        { agentOwner, backendOwner: ownerAccount.address, agentId },
        "Owner mismatch - cannot deposit"
      );
      res.status(403).json({
        error: "Not authorized",
        details: `Agent owner is ${agentOwner}, but backend owner is ${ownerAccount.address}. You can only deposit if you are the agent owner.`
      });
      return;
    }

    // Deposit to agent
    logger.info({ agentId, amount: amount.toString(), owner: ownerAccount.address }, "Depositing to agent");
    
    let depositHash: Hex;
    try {
      const { request: depositRequest } = await publicClient.simulateContract({
        account: ownerAccount,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "deposit",
        args: [BigInt(agentId), amount]
      });

      depositHash = await ownerClient.writeContract(depositRequest);
      logger.info({ depositHash }, "Deposit transaction sent");
    } catch (error: any) {
      // Try to decode error
      let errorMessage = (error as Error).message;
      if (error?.data) {
        try {
          const decoded = await publicClient.decodeErrorResult({
            abi: agentWalletAbi,
            data: error.data
          });
          errorMessage = `Contract error: ${decoded.errorName}`;
          logger.error({ decoded, agentId, amount: amount.toString() }, "Contract revert");
        } catch {
          // If decode fails, use original message
        }
      }
      logger.error({ error, agentId, amount: amount.toString() }, "Failed to deposit");
      res.status(500).json({ error: "Failed to deposit", details: errorMessage });
      return;
    }

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      logger.info({ depositHash, status: receipt.status }, "Deposit transaction confirmed");
    } catch (error) {
      logger.error({ error, depositHash }, "Failed to wait for deposit receipt");
      res.status(500).json({ error: "Failed to confirm deposit", details: (error as Error).message });
      return;
    }

    // Get new balance
    let newBalance: bigint;
    try {
      newBalance = (await publicClient.readContract({
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "balanceOf",
        args: [BigInt(agentId)]
      })) as bigint;
    } catch (error) {
      logger.error({ error }, "Failed to get new balance");
      // Still return success but without new balance
      res.json({
        transactionHash: depositHash,
        agentId,
        amount: amount.toString(),
        newBalance: "0",
        status: receipt.status,
        warning: "Failed to fetch new balance"
      });
      return;
    }

    res.json({
      transactionHash: depositHash,
      agentId,
      amount: amount.toString(),
      newBalance: newBalance.toString(),
      status: receipt.status
    });
  } catch (error) {
    logger.error({ error }, "Deposit endpoint error");
    next(error);
  }
});

app.post("/agent/pause", async (req, res, next) => {
  try {
    const { agentId, active } = pauseResumeSchema.parse(req.body);

    // Check if agent exists and get owner
    const config = await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "agent",
      args: [BigInt(agentId)]
    });

    const agentOwner = (config as { owner: Hex }).owner;

    // Check if caller is owner (for wallet-based signing, this will be checked on-chain)
    // For backend signing, check if backend owner matches
    const useBackendSigning = agentOwner.toLowerCase() === ownerAccount.address.toLowerCase();

    if (useBackendSigning) {
      // Backend signs
      const { request } = await publicClient.simulateContract({
        account: ownerAccount,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "setPolicyActive",
        args: [BigInt(agentId), active]
      });

      const hash = await ownerClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      res.json({
        transactionHash: hash,
        agentId,
        active,
        status: receipt.status
      });
    } else {
      // Prepare for frontend signing
      const { request } = await publicClient.simulateContract({
        account: agentOwner,
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "setPolicyActive",
        args: [BigInt(agentId), active]
      });

      res.json({
        transaction: serializeBigInt(request),
        agentId,
        active,
        needsSigning: true
      });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/agent/withdraw", async (req, res, next) => {
  try {
    const { agentId, amount } = withdrawSchema.parse(req.body);

    // Check if agent exists and get owner
    const config = await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "agent",
      args: [BigInt(agentId)]
    });

    const agentOwner = (config as { owner: Hex }).owner;
    const useBackendSigning = agentOwner.toLowerCase() === ownerAccount.address.toLowerCase();

    if (useBackendSigning) {
      // Backend signs
      let hash: Hex;
      if (amount) {
        // Normal withdraw
        const { request } = await publicClient.simulateContract({
          account: ownerAccount,
          address: env.AGENT_WALLET_ADDRESS as Hex,
          abi: agentWalletAbi,
          functionName: "withdraw",
          args: [BigInt(agentId), amount]
        });
        hash = await ownerClient.writeContract(request);
      } else {
        // Emergency withdraw
        const { request } = await publicClient.simulateContract({
          account: ownerAccount,
          address: env.AGENT_WALLET_ADDRESS as Hex,
          abi: agentWalletAbi,
          functionName: "emergencyWithdraw",
          args: [BigInt(agentId)]
        });
        hash = await ownerClient.writeContract(request);
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Get new balance
      const newBalance = (await publicClient.readContract({
        address: env.AGENT_WALLET_ADDRESS as Hex,
        abi: agentWalletAbi,
        functionName: "balanceOf",
        args: [BigInt(agentId)]
      })) as bigint;

      res.json({
        transactionHash: hash,
        agentId,
        amount: amount ? amount.toString() : "all",
        newBalance: newBalance.toString(),
        status: receipt.status
      });
    } else {
      // Prepare for frontend signing
      let request: any;
      if (amount) {
        const result = await publicClient.simulateContract({
          account: agentOwner,
          address: env.AGENT_WALLET_ADDRESS as Hex,
          abi: agentWalletAbi,
          functionName: "withdraw",
          args: [BigInt(agentId), amount]
        });
        request = result.request;
      } else {
        const result = await publicClient.simulateContract({
          account: agentOwner,
          address: env.AGENT_WALLET_ADDRESS as Hex,
          abi: agentWalletAbi,
          functionName: "emergencyWithdraw",
          args: [BigInt(agentId)]
        });
        request = result.request;
      }

      res.json({
        transaction: serializeBigInt(request),
        agentId,
        amount: amount ? amount.toString() : "all",
        needsSigning: true
      });
    }
  } catch (error) {
    next(error);
  }
});

app.get("/agent/:agentId", async (req, res, next) => {
  try {
    const agentId = BigInt(req.params.agentId);
    const config = (await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "agent",
      args: [agentId]
    })) as {
      owner: Hex;
      agent: Hex;
      policy: {
        active: boolean;
        dailyLimit: bigint;
        perTxLimit: bigint;
        spentToday: bigint;
        lastReset: bigint;
      };
    };

    const balance = (await publicClient.readContract({
      address: env.AGENT_WALLET_ADDRESS as Hex,
      abi: agentWalletAbi,
      functionName: "balanceOf",
      args: [agentId]
    })) as bigint;

    const knownRecord = agentStore.get(Number(agentId));

    res.json({
      agentId: agentId.toString(),
      owner: config.owner,
      agent: config.agent,
      balance: balance.toString(),
      policy: {
        active: config.policy.active,
        dailyLimit: config.policy.dailyLimit.toString(),
        perTxLimit: config.policy.perTxLimit.toString(),
        spentToday: config.policy.spentToday.toString(),
        lastReset: Number(config.policy.lastReset)
      },
      locallyTracked: knownRecord
        ? {
            storedPrivateKey: true,
            cachedDailyLimit: knownRecord.dailyLimit.toString(),
            cachedPerTxLimit: knownRecord.perTxLimit.toString()
          }
        : null
    });
  } catch (error) {
    next(error);
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(error, "Request failed");
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "ValidationError", details: error.flatten() });
    return;
  }
  res.status(500).json({ error: "InternalServerError", message: (error as Error).message });
});

app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      chainId: arcChain.id,
      owner: ownerAccount.address,
      agentWallet: env.AGENT_WALLET_ADDRESS
    },
    "Backend relayer started"
  );
});


