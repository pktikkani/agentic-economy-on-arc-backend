/**
 * Check native USDC balance on Arc + Gateway balance for the buyer.
 *
 * Run: npx tsx scripts/check-balances.ts
 */
import { createPublicClient, http, formatUnits } from "viem";
import { config } from "../src/config.js";
import { getCircleWalletConfig } from "../src/circle/dev-wallet.js";

const USDC_ON_ARC = "0x3600000000000000000000000000000000000000" as const;
const GATEWAY_WALLET_ARC = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

async function main() {
  const { walletAddress } = getCircleWalletConfig();

  const client = createPublicClient({
    transport: http(config.arc.rpcUrl),
  });

  // Native USDC balance (on Arc, USDC *is* the native token, so this is eth_getBalance)
  const nativeWei = await client.getBalance({ address: walletAddress });
  // Arc native USDC has 18 decimals per docs; ERC-20 interface exposes 6
  console.log(`Buyer address: ${walletAddress}`);
  console.log(`Native USDC (18 dec): ${formatUnits(nativeWei, 18)}`);

  const available = (await client.readContract({
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
  console.log("Gateway balances:", {
    availableAtomic: available.toString(),
    availableUsdc: formatUnits(available, 6),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
