import { brokerById, brokerUrl } from "../src/brokers/registry.js";
import { payBroker } from "../src/circle/pay.js";

async function main() {
  const [brokerId, ...inputParts] = process.argv.slice(2);
  if (!brokerId) {
    throw new Error("Usage: npx tsx scripts/pay-broker-json.ts <brokerId> <input>");
  }

  const input = inputParts.join(" ");
  const broker = brokerById(brokerId);
  const paid = await payBroker(brokerUrl(broker, "/service"), { input });
  console.log(
    JSON.stringify(
      {
        brokerId: broker.id,
        brokerName: broker.name,
        service: broker.service,
        price: broker.price,
        paid,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
