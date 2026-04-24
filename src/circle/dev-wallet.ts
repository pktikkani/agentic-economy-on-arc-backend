import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

export const ARC_TESTNET_BLOCKCHAIN = "ARC-TESTNET" as const;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing env var: ${name}. Check .env against .env.example.`);
  }
  return v;
}

export function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: requiredEnv("CIRCLE_API_KEY"),
    entitySecret: requiredEnv("CIRCLE_ENTITY_SECRET"),
  });
}

export function getCircleWalletConfig() {
  return {
    walletId: requiredEnv("CIRCLE_WALLET_ID"),
    walletAddress: requiredEnv("CIRCLE_WALLET_ADDRESS") as `0x${string}`,
  };
}

function mediumFee() {
  return {
    type: "level" as const,
    config: { feeLevel: "MEDIUM" as const },
  };
}

export async function waitForCircleTransaction(
  client: ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  id: string,
  label: string,
  timeoutMs = 120_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = (await client.getTransaction({ id })).data?.transaction as any;
    const state = tx?.state;
    if (state === "COMPLETE") return tx;
    if (state === "FAILED" || state === "CANCELED" || state === "DENIED") {
      throw new Error(`${label} tx ended in state ${state}. Full: ${JSON.stringify(tx)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${label} tx timeout after ${timeoutMs}ms`);
}

export async function createCircleTransfer(params: {
  amount: string;
  destinationAddress: `0x${string}`;
  refId?: string;
}): Promise<`0x${string}`> {
  const client = getCircleClient();
  const { walletId } = getCircleWalletConfig();
  const resp = await client.createTransaction({
    amount: [params.amount],
    destinationAddress: params.destinationAddress,
    tokenAddress: "",
    blockchain: ARC_TESTNET_BLOCKCHAIN as any,
    walletId,
    refId: params.refId,
    fee: mediumFee(),
  });
  const txId = (resp as any)?.data?.id as string | undefined;
  if (!txId) {
    throw new Error(`Circle transfer response missing tx id: ${JSON.stringify(resp)}`);
  }
  const tx = await waitForCircleTransaction(client, txId, "transfer");
  if (!tx?.txHash || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) {
    throw new Error(`Circle transfer missing tx hash: ${JSON.stringify(tx)}`);
  }
  return tx.txHash as `0x${string}`;
}

export async function createCircleContractExecution(params: {
  contractAddress: `0x${string}`;
  abiFunctionSignature: string;
  abiParameters: unknown[];
  amount?: string;
  refId?: string;
}): Promise<`0x${string}`> {
  const client = getCircleClient();
  const { walletId } = getCircleWalletConfig();
  const resp = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: params.contractAddress,
    abiFunctionSignature: params.abiFunctionSignature,
    abiParameters: params.abiParameters as any[],
    amount: params.amount,
    refId: params.refId,
    fee: mediumFee(),
  });
  const txId = (resp as any)?.data?.id as string | undefined;
  if (!txId) {
    throw new Error(`Circle contract execution missing tx id: ${JSON.stringify(resp)}`);
  }
  const tx = await waitForCircleTransaction(client, txId, "contract execution");
  if (!tx?.txHash || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) {
    throw new Error(`Circle contract execution missing tx hash: ${JSON.stringify(tx)}`);
  }
  return tx.txHash as `0x${string}`;
}
