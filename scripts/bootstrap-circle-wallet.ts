/**
 * Path 2 — Checkpoint 1: create a Circle Developer-Controlled wallet on Arc testnet.
 *
 * Run ONCE. It will:
 *   1. Generate a random entity secret (32 random bytes, hex)
 *   2. Register its ciphertext with Circle (saves a recovery file to ./output)
 *   3. Create a wallet set named "hackathon-demo"
 *   4. Create one EOA wallet on ARC-TESTNET
 *   5. Print wallet id, address, and the env vars you should add to .env
 *
 * Run: npx tsx scripts/bootstrap-circle-wallet.ts
 */
import crypto from "node:crypto";
import * as fs from "node:fs";
import "dotenv/config";
import {
  initiateDeveloperControlledWalletsClient,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function main() {
  const apiKey = required("CIRCLE_API_KEY");

  // If we already have an entity secret saved, reuse it. Otherwise generate.
  const envPath = ".env";
  let envBody = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  const existingSecret =
    /^CIRCLE_ENTITY_SECRET=([a-f0-9]{64})$/m.exec(envBody)?.[1] ?? null;

  let entitySecret: string;
  if (existingSecret) {
    entitySecret = existingSecret;
    console.log("Reusing existing CIRCLE_ENTITY_SECRET from .env");
  } else {
    entitySecret = crypto.randomBytes(32).toString("hex");
    console.log("Generated new entity secret. Registering ciphertext with Circle...");
    fs.mkdirSync("output", { recursive: true });
    await registerEntitySecretCiphertext({
      apiKey,
      entitySecret,
      recoveryFileDownloadPath: "./output",
    });
    console.log("Registered. Recovery file saved to ./output/");
    envBody += `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`;
    fs.writeFileSync(envPath, envBody);
    console.log("Saved CIRCLE_ENTITY_SECRET to .env");
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // Check whether we already have a wallet set for this project
  let walletSetId: string | undefined;
  const existingSetId = /^CIRCLE_WALLET_SET_ID=(.+)$/m.exec(envBody)?.[1]?.trim();
  if (existingSetId) {
    walletSetId = existingSetId;
    console.log(`Reusing wallet set ${walletSetId}`);
  } else {
    const set = (await client.createWalletSet({ name: "hackathon-demo" })).data?.walletSet;
    if (!set?.id) throw new Error("Failed to create wallet set");
    walletSetId = set.id;
    envBody += `CIRCLE_WALLET_SET_ID=${walletSetId}\n`;
    fs.writeFileSync(envPath, envBody);
    console.log(`Created wallet set ${walletSetId}`);
  }

  // Reuse wallet if present, else create
  let walletId: string | undefined;
  let walletAddress: string | undefined;
  const existingWalletId = /^CIRCLE_WALLET_ID=(.+)$/m.exec(envBody)?.[1]?.trim();
  const existingWalletAddress = /^CIRCLE_WALLET_ADDRESS=(0x[a-fA-F0-9]{40})$/m.exec(envBody)?.[1];
  if (existingWalletId && existingWalletAddress) {
    walletId = existingWalletId;
    walletAddress = existingWalletAddress;
    console.log(`Reusing wallet ${walletId} (${walletAddress})`);
  } else {
    const w = (
      await client.createWallets({
        walletSetId,
        blockchains: ["ARC-TESTNET"] as any,
        count: 1,
        accountType: "EOA",
      })
    ).data?.wallets?.[0];
    if (!w?.id || !w.address) throw new Error("Failed to create wallet");
    walletId = w.id;
    walletAddress = w.address;
    envBody += `CIRCLE_WALLET_ID=${walletId}\n`;
    envBody += `CIRCLE_WALLET_ADDRESS=${walletAddress}\n`;
    fs.writeFileSync(envPath, envBody);
    console.log(`Created wallet ${walletId}`);
    console.log(`  address: ${walletAddress}`);
  }

  // Query balance
  const bals = (await client.getWalletTokenBalance({ id: walletId! })).data?.tokenBalances ?? [];
  console.log("\nBalances:");
  if (bals.length === 0) {
    console.log("  (none yet — fund this address at https://faucet.circle.com on Arc testnet)");
  } else {
    for (const b of bals) {
      console.log(`  ${b.token?.symbol ?? "?"}: ${b.amount ?? "?"}`);
    }
  }

  console.log("\nNext step:");
  console.log(`  1. Fund https://faucet.circle.com → Arc testnet → ${walletAddress}`);
  console.log(`  2. Re-run this script — balance should show 10 USDC.`);
  console.log(`  3. Once funded, we'll wire the x402 signing flow through Circle's signTypedData.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
