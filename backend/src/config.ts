import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  ARC_RPC_URL: z.string().url(),
  AGENT_WALLET_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "AGENT_WALLET_ADDRESS must be a valid 0x-prefixed address"),
  OWNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "OWNER_PRIVATE_KEY must be a 64 hex character private key"),
  USDC_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "USDC_ADDRESS must be a valid 0x-prefixed address")
    .default("0x3600000000000000000000000000000000000000"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001)
});

export const env = envSchema.parse(process.env);


