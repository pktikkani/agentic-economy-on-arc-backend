import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === "0x" || v.trim() === "") {
    throw new Error(`Missing env var: ${name}. Check .env against .env.example.`);
  }
  return v;
}

export const config = {
  gemini: {
    apiKey: required("GOOGLE_GENERATIVE_AI_API_KEY"),
    // Empirically determined via scripts/compare-models.ts on 2026-04-21:
    // Flash 3 is 6x faster than Pro 3.1 Preview with identical judge scores
    // (1.00 across sentiment/price-lookup/summarize). Pro adds no quality
    // for our bounded task shapes. Override with GEMINI_MODEL if needed.
    model: process.env.GEMINI_MODEL ?? "gemini-3-flash-preview",
    thinkingLevel: (process.env.GEMINI_THINKING_LEVEL ?? "low") as "low" | "medium" | "high",
  },
  circle: {
    apiKey: process.env.CIRCLE_API_KEY ?? "",
  },
  wallets: {
    brokers: {
      A: required("BROKER_A_PRIVATE_KEY") as `0x${string}`,
      B: required("BROKER_B_PRIVATE_KEY") as `0x${string}`,
      C: required("BROKER_C_PRIVATE_KEY") as `0x${string}`,
      D: required("BROKER_D_PRIVATE_KEY") as `0x${string}`,
      E: required("BROKER_E_PRIVATE_KEY") as `0x${string}`,
    },
  },
  arc: {
    rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
    chainId: Number(process.env.ARC_CHAIN_ID ?? 5042002),
    explorer: process.env.ARC_EXPLORER ?? "https://testnet.arcscan.app",
    usdc: (process.env.USDC_CONTRACT ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
  },
} as const;
