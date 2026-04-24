import { BROKERS } from "../src/brokers/registry.js";
import { getCachedAgentIds, readReputation } from "../src/reputation/client.js";

async function main() {
  const agentIds = getCachedAgentIds();
  const brokers = await Promise.all(
    BROKERS.map(async (broker) => {
      const agentId = agentIds[broker.id] ?? null;
      return {
        id: broker.id,
        name: broker.name,
        service: broker.service,
        price: broker.price,
        quality: broker.quality,
        port: broker.port,
        agentId: agentId?.toString() ?? null,
        reputation: agentId ? await readReputation(agentId) : null,
      };
    })
  );
  console.log(JSON.stringify({ brokers }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
