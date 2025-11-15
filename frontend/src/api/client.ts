import axios from "axios";

// Use /api which will be proxied to backend by Vite
const baseURL = "/api";

export const api = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json"
  }
});

export type RegisterAgentPayload = {
  dailyLimit: string;
  perTxLimit: string;
};

export type RegisterAgentResponse = {
  agentId: string;
  agentAddress: `0x${string}`;
  agentPrivateKey: `0x${string}`;
  ownerAddress: `0x${string}`;
  transactionHash: `0x${string}`;
};

export type AgentPayPayload = {
  agentId: number;
  merchant: string;
  amount: string;
  data?: string;
};

export type AgentPayResponse = {
  transactionHash: `0x${string}`;
  agentId: number;
  merchant: string;
  amount: string;
  status: string;
};

export type AgentDetailsResponse = {
  agentId: string;
  owner: `0x${string}`;
  agent: `0x${string}`;
  balance: string;
  policy: {
    active: boolean;
    dailyLimit: string;
    perTxLimit: string;
    spentToday: string;
    lastReset: number;
  };
  locallyTracked: null | {
    storedPrivateKey: boolean;
    cachedDailyLimit: string;
    cachedPerTxLimit: string;
  };
};

export type WhitelistPayload = {
  agentId: number;
  merchant: string;
  allowed: boolean;
};

export type DepositPayload = {
  agentId: number;
  amount: string;
};

export type DepositResponse = {
  transactionHash: `0x${string}`;
  agentId: number;
  amount: string;
  newBalance: string;
  status: string;
};

export const registerAgent = async (payload: RegisterAgentPayload) => {
  const { data } = await api.post<RegisterAgentResponse>("/register-agent", payload);
  return data;
};

export const whitelistMerchant = async (payload: WhitelistPayload) => {
  const { data } = await api.post("/agent/whitelist", payload);
  return data as { transactionHash: `0x${string}` };
};

// Prepare whitelist transaction (for frontend signing)
export type PrepareWhitelistResponse = {
  transaction?: any;
  transactionHash?: `0x${string}`;
  agentId: number;
  merchant: string;
  allowed: boolean;
  needsSigning?: boolean;
};

export const prepareWhitelist = async (payload: WhitelistPayload) => {
  const { data } = await api.post<PrepareWhitelistResponse>("/agent/whitelist/prepare", payload);
  return data;
};

export const executePayment = async (payload: AgentPayPayload) => {
  const { data } = await api.post<AgentPayResponse>("/agent/pay", payload);
  return data;
};

// Prepare payment transaction (for frontend signing)
export type PreparePaymentResponse = {
  transaction: any;
  agentId: number;
  merchant: string;
  amount: string;
  agentAddress: `0x${string}`;
  needsSigning: boolean;
};

export const preparePayment = async (payload: AgentPayPayload) => {
  const { data } = await api.post<PreparePaymentResponse>("/agent/pay/prepare", payload);
  return data;
};

export const fetchAgentDetails = async (agentId: number) => {
  const { data } = await api.get<AgentDetailsResponse>(`/agent/${agentId}`);
  return data;
};

export const depositToAgent = async (payload: DepositPayload) => {
  const { data } = await api.post<DepositResponse>("/agent/deposit", payload);
  return data;
};

// Wallet-based registration
export type PrepareAgentResponse = {
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;
  transaction: any; // Transaction request from viem
};

export type CompleteAgentPayload = {
  agentId: number;
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  dailyLimit: string;
  perTxLimit: string;
  transactionHash: `0x${string}`;
};

export const prepareAgentCreation = async (payload: {
  dailyLimit: string;
  perTxLimit: string;
  ownerAddress?: string;
}) => {
  const { data } = await api.post<PrepareAgentResponse>("/register-agent/prepare", payload);
  return data;
};

export const completeAgentCreation = async (payload: CompleteAgentPayload) => {
  const { data } = await api.post<RegisterAgentResponse>("/register-agent/complete", payload);
  return data;
};

// Wallet-based deposit
export type PrepareDepositResponse = {
  transactions: Array<{
    type: "approve" | "deposit";
    transaction: any;
  }>;
  needsApproval?: boolean;
};

export const prepareDeposit = async (payload: {
  agentId: number;
  amount: string;
  ownerAddress: string;
}) => {
  const { data } = await api.post<PrepareDepositResponse>("/agent/deposit/prepare", payload);
  return data;
};

// Pause/Resume Agent
export type PauseResumePayload = {
  agentId: number;
  active: boolean;
};

export type PauseResumeResponse = {
  transactionHash?: `0x${string}`;
  transaction?: any;
  agentId: number;
  active: boolean;
  needsSigning?: boolean;
  status?: string;
};

export const pauseResumeAgent = async (payload: PauseResumePayload) => {
  const { data } = await api.post<PauseResumeResponse>("/agent/pause", payload);
  return data;
};

// Withdraw
export type WithdrawPayload = {
  agentId: number;
  amount?: string; // If not provided, emergency withdraw
};

export type WithdrawResponse = {
  transactionHash?: `0x${string}`;
  transaction?: any;
  agentId: number;
  amount: string; // "all" for emergency withdraw
  newBalance?: string;
  needsSigning?: boolean;
  status?: string;
};

export const withdrawFromAgent = async (payload: WithdrawPayload) => {
  const { data } = await api.post<WithdrawResponse>("/agent/withdraw", payload);
  return data;
};


