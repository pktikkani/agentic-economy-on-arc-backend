/**
 * Path 2 — Checkpoint 5: deposit USDC from our Circle wallet into the
 * Gateway Wallet contract so x402 batched payments can settle.
 *
 * Two on-chain txs via Circle's contract execution API — both appear in
 * https://console.circle.com/wallets/dev :
 *   1. USDC.approve(GatewayWallet, amount)
 *   2. GatewayWallet.deposit(USDC, amount)
 *
 * Run: npx tsx scripts/deposit-to-gateway.ts [amount]
 */
import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, parseUnits, formatUnits } from "viem";

const USDC_ON_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET_ARC = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ARC_RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function waitForOnchain(client: any, txId: string, label: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = (await client.getTransaction({ id: txId })).data?.transaction;
    const state = tx?.state;
    if (state === "COMPLETE") {
      return tx;
    }
    if (state === "FAILED" || state === "CANCELED" || state === "DENIED") {
      throw new Error(`${label} tx ended in state ${state}. Full: ${JSON.stringify(tx)}`);
    }
    console.log(`  ...${label} state: ${state}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label} tx timeout after ${timeoutMs}ms`);
}

async function main() {
  const amountStr = process.argv[2] ?? "5";
  const apiKey = required("CIRCLE_API_KEY");
  const entitySecret = required("CIRCLE_ENTITY_SECRET");
  const walletId = required("CIRCLE_WALLET_ID");
  const walletAddress = required("CIRCLE_WALLET_ADDRESS");

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const amountAtomic = parseUnits(amountStr, 6); // USDC ERC-20 uses 6 decimals
  console.log(`Depositing ${amountStr} USDC (atomic ${amountAtomic.toString()}) from ${walletAddress} into Gateway...`);

  // 1. Approve
  console.log("\n[1/2] Approving Gateway to spend USDC...");
  const approveResp = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: USDC_ON_ARC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [GATEWAY_WALLET_ARC, amountAtomic.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const approveId = (approveResp as any).data?.id;
  console.log(`  Circle tx id: ${approveId}`);
  const approveTx = await waitForOnchain(client, approveId, "approve");
  console.log(`  on-chain hash: ${approveTx.txHash}`);
  console.log(`  https://testnet.arcscan.app/tx/${approveTx.txHash}`);

  // 2. Deposit
  console.log("\n[2/2] Depositing into Gateway Wallet...");
  const depositResp = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: GATEWAY_WALLET_ARC,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [USDC_ON_ARC, amountAtomic.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const depositId = (depositResp as any).data?.id;
  console.log(`  Circle tx id: ${depositId}`);
  const depositTx = await waitForOnchain(client, depositId, "deposit");
  console.log(`  on-chain hash: ${depositTx.txHash}`);
  console.log(`  https://testnet.arcscan.app/tx/${depositTx.txHash}`);

  // Verify balance in Gateway
  const pub = createPublicClient({ transport: http(ARC_RPC) });
  const deposited = (await pub.readContract({
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
    args: [USDC_ON_ARC, walletAddress as `0x${string}`],
  })) as bigint;
  console.log(`\n✅ Gateway available balance: ${formatUnits(deposited, 6)} USDC`);
  console.log("   Ready for x402 batched payments.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
