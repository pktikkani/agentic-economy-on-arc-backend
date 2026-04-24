/**
 * Agent payment path — now routed through Circle Developer-Controlled
 * Wallets (Path 2). Every x402 authorization is signed by Circle's
 * signTypedData API, so every payment appears in
 * https://console.circle.com/wallets/dev/transactions automatically.
 *
 * See src/circle/circle-pay.ts for the signing implementation and
 * scripts/deposit-to-gateway.ts for the one-time Gateway deposit.
 */
import { circlePay } from "./circle-pay.js";
import { createPublicClient, http } from "viem";
import { config } from "../config.js";

const USDC_ON_ARC = "0x3600000000000000000000000000000000000000" as const;
const GATEWAY_WALLET_ARC = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

const pub = createPublicClient({ transport: http(config.arc.rpcUrl) });

/**
 * Ensure the Circle-managed buyer has at least `minUsdc` in the Gateway
 * deposit. Unlike the old local-key flow, we don't auto-deposit here — if
 * balance is low the agent demo stops early and prints how to top up.
 * Depositing from Circle requires an approve + deposit pair (see
 * scripts/deposit-to-gateway.ts).
 */
export async function ensureGatewayFunded(minUsdc = 1): Promise<void> {
  const walletAddress = process.env.CIRCLE_WALLET_ADDRESS as `0x${string}` | undefined;
  if (!walletAddress) {
    throw new Error("Missing CIRCLE_WALLET_ADDRESS — run scripts/bootstrap-circle-wallet.ts");
  }
  const available = (await pub.readContract({
    address: GATEWAY_WALLET_ARC,
    abi: [
      {
        name: "availableBalance",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "token", type: "address" },
          { name: "depositor", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "availableBalance",
    args: [USDC_ON_ARC, walletAddress],
  })) as bigint;

  const minAtomic = BigInt(Math.floor(minUsdc * 1_000_000));
  if (available < minAtomic) {
    throw new Error(
      `Gateway available balance (${available}) below minimum (${minAtomic}). Top up: npx tsx scripts/deposit-to-gateway.ts <amount>`
    );
  }
}

/**
 * Pay a broker via x402 batched nanopayment, signed by Circle.
 * We encode the body into a base64url query parameter (GET) because the
 * older SDK's pay() was observed to drop POST bodies, and our homemade
 * circlePay() mirrors that constraint for consistency with seller routing.
 */
export async function payBroker(url: string, body: unknown): Promise<{
  status: number;
  data: any;
}> {
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sep = url.includes("?") ? "&" : "?";
  const urlWithPayload = `${url}${sep}payload=${payload}`;
  return circlePay(urlWithPayload);
}
