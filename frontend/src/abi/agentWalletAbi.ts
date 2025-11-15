export const agentWalletAbi = [
  {
    inputs: [
      { internalType: "address", name: "agentAddress", type: "address" },
      { internalType: "uint256", name: "dailyLimit", type: "uint256" },
      { internalType: "uint256", name: "perTxLimit", type: "uint256" }
    ],
    name: "createAgent",
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "address", name: "merchant", type: "address" },
      { internalType: "bool", name: "allowed", type: "bool" }
    ],
    name: "setMerchantWhitelist",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "address", name: "merchant", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "bytes", name: "data", type: "bytes" }
    ],
    name: "pay",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "agent",
    outputs: [
      {
        components: [
          { internalType: "address", name: "owner", type: "address" },
          { internalType: "address", name: "agent", type: "address" },
          {
            components: [
              { internalType: "bool", name: "active", type: "bool" },
              { internalType: "uint256", name: "dailyLimit", type: "uint256" },
              { internalType: "uint256", name: "perTxLimit", type: "uint256" },
              { internalType: "uint256", name: "spentToday", type: "uint256" },
              { internalType: "uint64", name: "lastReset", type: "uint64" }
            ],
            internalType: "struct AgentWallet.Policy",
            name: "policy",
            type: "tuple"
          }
        ],
        internalType: "struct AgentWallet.AgentConfig",
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "address", name: "merchant", type: "address" }
    ],
    name: "isMerchantWhitelisted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "spentToday",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "bool", name: "active", type: "bool" }
    ],
    name: "setPolicyActive",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "emergencyWithdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "agent", type: "address" }
    ],
    name: "AgentCreated",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: true, internalType: "address", name: "merchant", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "data", type: "bytes" }
    ],
    name: "AgentPayment",
    type: "event"
  },
  {
    inputs: [],
    name: "AgentWallet__AgentNotFound",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__NotAgentOwner",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__NotAgent",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__PolicyInactive",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__MerchantNotAllowed",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__PerTxLimitExceeded",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__DailyLimitExceeded",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__InsufficientBalance",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__InvalidAddress",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__InvalidAmount",
    type: "error"
  },
  {
    inputs: [],
    name: "AgentWallet__InvalidLimits",
    type: "error"
  }
] as const;
