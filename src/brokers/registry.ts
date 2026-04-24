/**
 * Broker registry - the 3-5 "seller" agents, each with a different
 * price/quality tradeoff. In Day 3 these prices + reputations drive
 * the requester's selection logic.
 */
import { config } from "../config.js";
import { privateKeyToAccount } from "viem/accounts";

export type BrokerService = "sentiment" | "price-lookup" | "summarize";

export type BrokerSpec = {
  id: "A" | "B" | "C" | "D" | "E";
  name: string;
  service: BrokerService;
  /** USD price per call, e.g. "$0.005" — consumed by gateway.require() */
  price: string;
  /** 0..1 intrinsic quality hint used to seed reputation (for demo) */
  quality: number;
  address: `0x${string}`;
  port: number;
};

export const BROKERS: BrokerSpec[] = [
  {
    id: "A",
    name: "FastSent",
    service: "sentiment",
    price: "$0.003",
    quality: 0.65,
    address: privateKeyToAccount(config.wallets.brokers.A).address,
    port: 3001,
  },
  {
    id: "B",
    name: "DeepSent",
    service: "sentiment",
    price: "$0.008",
    quality: 0.92,
    address: privateKeyToAccount(config.wallets.brokers.B).address,
    port: 3002,
  },
  {
    id: "C",
    name: "QuickPrice",
    service: "price-lookup",
    price: "$0.002",
    quality: 0.70,
    address: privateKeyToAccount(config.wallets.brokers.C).address,
    port: 3003,
  },
  {
    id: "D",
    name: "SharpPrice",
    service: "price-lookup",
    price: "$0.007",
    quality: 0.95,
    address: privateKeyToAccount(config.wallets.brokers.D).address,
    port: 3004,
  },
  {
    id: "E",
    name: "Summarizer",
    service: "summarize",
    price: "$0.005",
    quality: 0.85,
    address: privateKeyToAccount(config.wallets.brokers.E).address,
    port: 3005,
  },
];

export function brokerUrl(b: BrokerSpec, path = "/service"): string {
  return `http://localhost:${b.port}${path}`;
}

export function brokerById(id: string): BrokerSpec {
  const b = BROKERS.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown broker id: ${id}`);
  return b;
}
