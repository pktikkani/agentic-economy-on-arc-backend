/**
 * ERC-8004 reputation client — reads and writes to the on-chain registries.
 *
 * Design:
 *   - Each broker registers itself once on IdentityRegistry (getting an agentId NFT)
 *   - Registration results are cached to disk (.cache/broker-ids.json) so
 *     re-runs skip the on-chain registration step
 *   - After each paid interaction, the REQUESTER posts feedback about the broker
 *   - Before picking a broker, the requester reads getSummary for each one
 */
import { createPublicClient, createWalletClient, http, decodeEventLog, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { BROKERS, type BrokerSpec } from "../brokers/registry.js";
import { identityRegistryAbi, reputationRegistryAbi, ERC8004_ADDRESSES } from "./abi.js";
import { createCircleContractExecution, getCircleWalletConfig } from "../circle/dev-wallet.js";

const CACHE_PATH = path.join(process.cwd(), ".cache", "broker-ids.json");
const DEFAULT_AGENT_IDS: CachedIds = {
  A: "2424",
  B: "2425",
  C: "2426",
  D: "2427",
  E: "2428",
};

const arcChain = {
  id: config.arc.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
} as const;

const pub = createPublicClient({
  chain: arcChain as any,
  transport: http(config.arc.rpcUrl),
});

function walletFor(pk: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(pk),
    chain: arcChain as any,
    transport: http(config.arc.rpcUrl),
  });
}

type CachedIds = Record<string, string>; // brokerId -> agentId (decimal string)

function loadCache(): CachedIds {
  if (process.env.BROKER_AGENT_IDS_JSON) {
    return JSON.parse(process.env.BROKER_AGENT_IDS_JSON);
  }
  const envIds: CachedIds = {};
  for (const id of ["A", "B", "C", "D", "E"]) {
    const value = process.env[`BROKER_AGENT_ID_${id}`];
    if (value) envIds[id] = value;
  }
  if (Object.keys(envIds).length > 0) return envIds;
  if (!fs.existsSync(CACHE_PATH)) return DEFAULT_AGENT_IDS;
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
}

function saveCache(c: CachedIds) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}

/**
 * Register a broker on the IdentityRegistry. Idempotent via cache.
 * Returns the agentId as a bigint.
 */
export async function registerBroker(broker: BrokerSpec): Promise<bigint> {
  const cache = loadCache();
  if (cache[broker.id]) {
    return BigInt(cache[broker.id]!);
  }

  const w = walletFor(config.wallets.brokers[broker.id]);
  const agentURI = `ipfs://mock/${broker.id}-${broker.name}`; // mock URI for demo

  console.log(`[rep] Registering broker ${broker.id} (${broker.name})...`);
  const hash = await w.writeContract({
    chain: arcChain as any,
    address: ERC8004_ADDRESSES.identity,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentURI],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });

  // Pull the Registered event to get the agentId
  let agentId: bigint | undefined;
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== ERC8004_ADDRESSES.identity.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "Registered") {
        agentId = (decoded.args as any).agentId as bigint;
        break;
      }
    } catch {}
  }
  if (agentId === undefined) throw new Error(`Could not parse Registered event for broker ${broker.id}`);

  cache[broker.id] = agentId.toString();
  saveCache(cache);
  console.log(`[rep]   ${broker.id} agentId=${agentId} tx=${config.arc.explorer}/tx/${hash}`);
  return agentId;
}

export async function registerAllBrokers(): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const b of BROKERS) {
    out[b.id] = await registerBroker(b);
  }
  return out;
}

export function getCachedAgentIds(): Record<string, bigint> {
  const c = loadCache();
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(c)) out[k] = BigInt(v);
  return out;
}

/**
 * Post reputation feedback from the REQUESTER about a broker.
 * quality ∈ [0,1] — stored with 2 decimals, so value = round(quality*100).
 */
export async function giveFeedback(
  brokerAgentId: bigint,
  quality: number,
  tag1 = "quality",
  tag2 = ""
): Promise<`0x${string}`> {
  const value = BigInt(Math.round(Math.max(0, Math.min(1, quality)) * 100));
  return createCircleContractExecution({
    contractAddress: ERC8004_ADDRESSES.reputation,
    abiFunctionSignature:
      "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters: [
      brokerAgentId.toString(),
      value.toString(),
      2,
      tag1,
      tag2,
      "",
      "",
      keccak256(toHex(`${brokerAgentId}-${Date.now()}-${value}`)),
    ],
    refId: `feedback-${brokerAgentId}-${Date.now()}`,
  });
}

/**
 * Read aggregated reputation for one broker, scoped to feedback from our buyer.
 * getSummary requires a non-empty clientAddresses array.
 * Returns an average in [0,1]. If no feedback yet, returns null.
 */
export async function readReputation(brokerAgentId: bigint): Promise<{ count: number; avg: number } | null> {
  const buyerAddr = getCircleWalletConfig().walletAddress;
  const [count, summaryValue, summaryValueDecimals] = (await pub.readContract({
    address: ERC8004_ADDRESSES.reputation,
    abi: reputationRegistryAbi,
    functionName: "getSummary",
    args: [brokerAgentId, [buyerAddr], "quality", ""],
  })) as [bigint, bigint, number];

  if (count === 0n) return null;
  // summaryValue is the aggregate; registry convention: average = summaryValue / 10^decimals.
  const avg = Number(summaryValue) / 10 ** summaryValueDecimals;
  return { count: Number(count), avg };
}
