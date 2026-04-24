import { brokerById, brokerUrl } from "../src/brokers/registry.js";
import { circlePay } from "../src/circle/circle-pay.js";

async function main() {
  const [brokerId] = process.argv.slice(2);
  if (!brokerId) {
    throw new Error("Usage: npx tsx scripts/pay-broker-fast-json.ts <brokerId>");
  }

  const broker = brokerById(brokerId);
  const paid = await circlePay(brokerUrl(broker, "/service-fast"));
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
