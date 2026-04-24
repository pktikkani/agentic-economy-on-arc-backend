/**
 * Multi-broker seller server. Launches one Express app per broker on its own port,
 * each charging its own price and exposing /service via x402.
 *
 * Run: npx tsx src/brokers/seller-server.ts
 */
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { BROKERS, type BrokerSpec } from "./registry.js";
import { runBrokerService } from "./service-impl.js";

function startBroker(broker: BrokerSpec) {
  const app = express();
  app.use(express.json());

  const gateway = createGatewayMiddleware({
    sellerAddress: broker.address,
  });

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      id: broker.id,
      name: broker.name,
      service: broker.service,
      price: broker.price,
      quality: broker.quality,
      address: broker.address,
    })
  );

  // Decode payload from query string (see comment in src/circle/pay.ts — the
  // SDK drops POST bodies on the paid retry, so we use a base64url-encoded
  // query parameter instead).
  const decodePayload = (req: any): { input: string } => {
    const p = req.query?.payload;
    if (typeof p === "string" && p.length > 0) {
      try {
        const decoded = Buffer.from(p, "base64url").toString("utf8");
        const obj = JSON.parse(decoded);
        return { input: String(obj?.input ?? "") };
      } catch {
        return { input: "" };
      }
    }
    // Fallback: POST body (works for plain fetch; kept for compatibility)
    return { input: String(req.body?.input ?? "") };
  };

  // Regular agent path: real Gemini inference. We accept GET now because the
  // SDK's pay() only reliably conveys URL state, not body.
  const serviceHandler = async (req: any, res: any) => {
    const { payer, amount, network } = req.payment ?? {};
    const { input } = decodePayload(req);
    console.log(`[${broker.id}] RECV input="${input.slice(0, 120)}" len=${input.length}`);
    try {
      const result = await runBrokerService(broker, input);
      console.log(`[${broker.id} ${broker.name}] paid=${amount} by ${payer} net=${network}`);
      res.json({
        broker_id: broker.id,
        broker_name: broker.name,
        service: broker.service,
        result,
        payment: { payer, amount, network },
        ts: Date.now(),
      });
    } catch (e: any) {
      console.error(`[${broker.id}] service error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
  app.get("/service", gateway.require(broker.price), serviceHandler);
  app.post("/service", gateway.require(broker.price), serviceHandler);

  // Fast path for 50-tx proof: same pricing, same x402 settlement on Arc,
  // but skips the LLM call. Used by scripts/fifty-tx.ts to meet the
  // 50+ on-chain tx requirement without spending minutes on Gemini latency.
  app.get("/service-fast", gateway.require(broker.price), (req: any, res) => {
    const { payer, amount, network } = req.payment ?? {};
    res.json({
      broker_id: broker.id,
      broker_name: broker.name,
      service: broker.service,
      result: { output: "ack", confidence: broker.quality },
      payment: { payer, amount, network },
      ts: Date.now(),
    });
  });
  app.post("/service-fast", gateway.require(broker.price), (req: any, res) => {
    const { payer, amount, network } = req.payment ?? {};
    res.json({
      broker_id: broker.id,
      broker_name: broker.name,
      service: broker.service,
      result: { output: "ack", confidence: broker.quality },
      payment: { payer, amount, network },
      ts: Date.now(),
    });
  });

  app.listen(broker.port, () => {
    console.log(`[${broker.id} ${broker.name}] ${broker.service} @ ${broker.price} listening on :${broker.port}`);
  });
}

for (const b of BROKERS) startBroker(b);
