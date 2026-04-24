/**
 * One-time: register all 5 brokers on ERC-8004 IdentityRegistry on Arc.
 * Idempotent — cached to .cache/broker-ids.json.
 *
 * Broker wallets need a tiny amount of native USDC gas. If they're empty we
 * top them up from the Circle-managed buyer wallet.
 *
 * Run: npx tsx scripts/register-brokers.ts
 */
import { createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { BROKERS } from "../src/brokers/registry.js";
import { registerAllBrokers, getCachedAgentIds } from "../src/reputation/client.js";
import { createCircleTransfer } from "../src/circle/dev-wallet.js";

const arcChain = {
  id: config.arc.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
} as const;

const pub = createPublicClient({ chain: arcChain as any, transport: http(config.arc.rpcUrl) });

async function fundBrokerIfNeeded(brokerKey: `0x${string}`, minNative: bigint) {
  const acct = privateKeyToAccount(brokerKey);
  const bal = await pub.getBalance({ address: acct.address });
  if (bal >= minNative) return;

  console.log(`Funding ${acct.address} with 0.01 USDC gas (has ${formatEther(bal)})...`);
  const hash = await createCircleTransfer({
    amount: "0.01",
    destinationAddress: acct.address,
    refId: `fund-broker-${acct.address}-${Date.now()}`,
  });
  console.log(`  funded: ${config.arc.explorer}/tx/${hash}`);
}

async function main() {
  const minGas = parseEther("0.005"); // 0.005 USDC native gas buffer per broker
  for (const b of BROKERS) {
    await fundBrokerIfNeeded(config.wallets.brokers[b.id], minGas);
  }

  const ids = await registerAllBrokers();
  console.log("\nAll broker agentIds:");
  for (const [bid, aid] of Object.entries(ids)) {
    console.log(`  ${bid} -> ${aid}`);
  }

  console.log("\nCache:", getCachedAgentIds());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
