import { getCachedAgentIds, giveFeedback } from "../src/reputation/client.js";

async function main() {
  const [brokerId, qualityArg] = process.argv.slice(2);
  if (!brokerId || !qualityArg) {
    throw new Error("Usage: npx tsx scripts/give-feedback-json.ts <brokerId> <quality>");
  }

  const quality = Number(qualityArg);
  if (!Number.isFinite(quality)) {
    throw new Error(`Invalid quality: ${qualityArg}`);
  }

  const agentIds = getCachedAgentIds();
  const agentId = agentIds[brokerId as keyof typeof agentIds];
  if (!agentId) {
    throw new Error(`No cached agentId for broker ${brokerId}`);
  }

  const txHash = await giveFeedback(agentId, quality);
  console.log(JSON.stringify({ brokerId, quality, txHash }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
