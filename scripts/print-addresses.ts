/**
 * Print the public address for every wallet in .env.
 * Paste the Circle buyer address into https://faucet.circle.com (Arc testnet)
 * to get USDC.
 *
 * Run: npx tsx scripts/print-addresses.ts
 */
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { getCircleWalletConfig } from "../src/circle/dev-wallet.js";

function show(label: string, pk: `0x${string}`) {
  const acct = privateKeyToAccount(pk);
  console.log(`${label.padEnd(10)} ${acct.address}`);
}

const { walletAddress } = getCircleWalletConfig();

console.log("Wallet addresses:\n");
console.log(`${"BUYER".padEnd(10)} ${walletAddress}`);
show("BROKER_A", config.wallets.brokers.A);
show("BROKER_B", config.wallets.brokers.B);
show("BROKER_C", config.wallets.brokers.C);
show("BROKER_D", config.wallets.brokers.D);
show("BROKER_E", config.wallets.brokers.E);

console.log("\nFund the BUYER address at https://faucet.circle.com (select Arc testnet).");
