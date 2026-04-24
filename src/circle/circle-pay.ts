/**
 * Path 2: x402 nanopayment client that signs via Circle Developer-Controlled
 * Wallets instead of a local private key.
 *
 * Every tx our agent fires is visible at https://console.circle.com/wallets/dev
 * because Circle is the signer.
 *
 * Flow:
 *   1. GET/POST the seller URL → 402 Payment Required, with a PAYMENT-REQUIRED
 *      header carrying the base64 JSON of payment options.
 *   2. Pick the Arc batching option (extra.name === "GatewayWalletBatched").
 *   3. Build an EIP-3009 TransferWithAuthorization EIP-712 message matching
 *      the exact shape the seller's Gateway middleware expects (extracted from
 *      @circle-fin/x402-batching source).
 *   4. Call Circle's signTypedData API → get a 0x... signature.
 *   5. Base64-encode { x402Version, payload: {authorization, signature},
 *      resource, accepted } and send as Payment-Signature header on the retry.
 *   6. Seller verifies → serves the paid resource.
 *
 * References:
 *   - @circle-fin/x402-batching/dist/client/index.js lines 70-175 (payload shape)
 *   - @circle-fin/x402-batching/dist/client/index.js lines 870-935 (wire flow)
 */
import "dotenv/config";
import { getAddress } from "viem";
import { config } from "../config.js";
import { getCircleClient, getCircleWalletConfig } from "./dev-wallet.js";

const CIRCLE_BATCHING_NAME = "GatewayWalletBatched";
const CIRCLE_BATCHING_VERSION = "1";

// EIP-712 types for the EIP-3009 authorization (matches SDK source)
const authorizationTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

type PaymentRequirement = {
  scheme: string;
  network: string; // "eip155:5042002"
  asset: string;
  amount: string; // atomic units
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    verifyingContract?: string;
  };
};

type PaymentRequired = {
  x402Version: number;
  resource: unknown;
  accepts: PaymentRequirement[];
};

function randomNonceHex(): string {
  const bytes = new Uint8Array(32);
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(bytes);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pickArcBatchingOption(req: PaymentRequired): PaymentRequirement {
  const expectedNetwork = `eip155:${config.arc.chainId}`;
  const opt = req.accepts.find(
    (o) =>
      o.network === expectedNetwork &&
      o.extra?.name === CIRCLE_BATCHING_NAME &&
      o.extra?.version === CIRCLE_BATCHING_VERSION &&
      typeof o.extra?.verifyingContract === "string"
  );
  if (!opt) {
    throw new Error(
      `No Arc GatewayWalletBatched option in 402 response. Got ${JSON.stringify(req.accepts.map((a) => ({ net: a.network, name: a.extra?.name })))}`
    );
  }
  return opt;
}

async function signAuthorizationViaCircle(
  walletId: string,
  fromAddress: `0x${string}`,
  requirement: PaymentRequirement
): Promise<{ authorization: Record<string, string>; signature: string }> {
  const verifyingContract = getAddress(requirement.extra!.verifyingContract!);
  const to = getAddress(requirement.payTo);
  const chainId = Number(requirement.network.split(":")[1]);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: fromAddress,
    to,
    value: requirement.amount,
    validAfter: (now - 600).toString(),
    validBefore: (now + requirement.maxTimeoutSeconds).toString(),
    nonce: randomNonceHex(),
  };

  const typedData = {
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    domain: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      chainId,
      verifyingContract,
    },
    message: authorization,
  };

  const client = getCircleClient();
  const resp = await client.signTypedData({
    walletId,
    data: JSON.stringify(typedData),
  });
  const signature = (resp as any)?.data?.signature as string | undefined;
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error(`Circle signTypedData returned malformed signature: ${signature}`);
  }

  return { authorization, signature };
}

export async function circlePay<T = any>(url: string): Promise<{
  status: number;
  data: T;
}> {
  const { walletId, walletAddress } = getCircleWalletConfig();

  // 1. Initial request → expect 402
  const initial = await fetch(url, { method: "GET" });

  if (initial.status !== 402) {
    if (initial.ok) {
      const data = await initial.json();
      return { status: initial.status, data };
    }
    throw new Error(`Unexpected status ${initial.status} on initial request`);
  }

  const header = initial.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("Missing PAYMENT-REQUIRED header on 402");
  const paymentRequired: PaymentRequired = JSON.parse(
    Buffer.from(header, "base64").toString("utf8")
  );

  // 2. Pick Arc batching option
  const arcOption = pickArcBatchingOption(paymentRequired);

  // 3+4. Sign via Circle
  const { authorization, signature } = await signAuthorizationViaCircle(
    walletId,
    walletAddress,
    arcOption
  );

  // 5. Assemble Payment-Signature header exactly like the SDK does
  const paymentHeader = Buffer.from(
    JSON.stringify({
      x402Version: paymentRequired.x402Version ?? 2,
      payload: { authorization, signature },
      resource: paymentRequired.resource,
      accepted: arcOption,
    })
  ).toString("base64");

  // 6. Retry with signed header
  const paid = await fetch(url, {
    method: "GET",
    headers: { "Payment-Signature": paymentHeader },
  });

  if (!paid.ok) {
    const errBody = await paid.text();
    throw new Error(`Paid request failed ${paid.status}: ${errBody.slice(0, 500)}`);
  }

  const data = (await paid.json()) as T;
  return { status: paid.status, data };
}
