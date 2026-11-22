import { createFakeIntervalsServer, SERVER_KEY } from "../../../test/fake-intervals-server";
import { createFakePublisher } from "../../../test/fake-publisher";
import { describePublisherContract } from "../../../test/publisher-contract";
import { createIntervalsPublisher } from "./intervals-publisher";

describePublisherContract("in-memory fake", () => {
  const publisher = createFakePublisher();
  return {
    publisher,
    seedForeign: (date) => publisher.seedForeign(date),
    dateOf: (id) => publisher.remote.get(id)?.date,
  };
});

describePublisherContract(
  "intervals adapter",
  () => {
    const server = createFakeIntervalsServer();
    return {
      publisher: createIntervalsPublisher(server.client, {
        now: () => new Date("2026-03-01T00:00:00Z"),
      }),
      seedForeign: (date) => String(server.seedForeign(date)),
      dateOf: (id) => server.dateOf(Number(id)),
    };
  },
  { secrets: [SERVER_KEY, Buffer.from(`API_KEY:${SERVER_KEY}`).toString("base64")] },
);
