import { describe, expect, it } from "vitest";
import {
  PublisherError,
  PublisherForeignEventError,
  PublisherNotFoundError,
  type PublishInput,
  type WorkoutPublisher,
} from "../src/modules/calendar/index";

const input: PublishInput = {
  externalId: "wristplan-contract-1",
  date: "2026-03-02",
  name: "Easy run",
  text: "Warmup\n- 10m Z1 HR",
  sport: "run",
  target: "hr",
};

export interface ContractHarness {
  readonly publisher: WorkoutPublisher;
  /** Plants an event not created by wristplan and returns its remote id. */
  seedForeign(date: string): string;
  /** Date (YYYY-MM-DD) of a remote event, undefined if it does not exist. */
  dateOf(remoteId: string): string | undefined;
}

export interface ContractOptions {
  readonly secrets?: readonly string[];
}

// Reusable for any WorkoutPublisher implementation (e.g. a future Garmin Training API adapter).
export function describePublisherContract(
  name: string,
  makeHarness: () => ContractHarness,
  options: ContractOptions = {},
): void {
  const makePublisher = () => makeHarness().publisher;
  describe(`WorkoutPublisher contract: ${name}`, () => {
    it("publish returns a non-empty remote id", async () => {
      const { remoteId } = await makePublisher().publish(input);
      expect(remoteId).toMatch(/\S/);
    });

    it("publishing the same externalId twice does not duplicate", async () => {
      const publisher = makePublisher();
      const first = await publisher.publish(input);
      const second = await publisher.publish({ ...input, date: "2026-03-03" });
      expect(second.remoteId).toBe(first.remoteId);
    });

    it("distinct externalIds get distinct remote ids", async () => {
      const publisher = makePublisher();
      const a = await publisher.publish(input);
      const b = await publisher.publish({ ...input, externalId: "wristplan-contract-2" });
      expect(b.remoteId).not.toBe(a.remoteId);
    });

    it("publishing the same externalId again moves it to the new date", async () => {
      const h = makeHarness();
      const { remoteId } = await h.publisher.publish(input);
      await h.publisher.publish({ ...input, date: "2026-03-03" });
      expect(h.dateOf(remoteId)).toBe("2026-03-03");
    });

    it("reschedules a published workout", async () => {
      const h = makeHarness();
      const { remoteId } = await h.publisher.publish(input);
      await expect(h.publisher.reschedule(remoteId, "2026-03-09")).resolves.toBeUndefined();
      expect(h.dateOf(remoteId)).toBe("2026-03-09");
    });

    it("refuses to reschedule a foreign event and leaves it untouched", async () => {
      const h = makeHarness();
      const id = h.seedForeign("2026-03-02");
      await expect(h.publisher.reschedule(id, "2026-03-09")).rejects.toBeInstanceOf(
        PublisherForeignEventError,
      );
      expect(h.dateOf(id)).toBe("2026-03-02");
    });

    it("refuses to remove a foreign event and leaves it in place", async () => {
      const h = makeHarness();
      const id = h.seedForeign("2026-03-02");
      await expect(h.publisher.remove(id)).rejects.toBeInstanceOf(PublisherForeignEventError);
      expect(h.dateOf(id)).toBe("2026-03-02");
    });

    it("removing deletes only the targeted event", async () => {
      const h = makeHarness();
      const a = await h.publisher.publish(input);
      const b = await h.publisher.publish({ ...input, externalId: "wristplan-contract-2" });
      await h.publisher.remove(a.remoteId);
      expect(h.dateOf(a.remoteId)).toBeUndefined();
      expect(h.dateOf(b.remoteId)).toBe(input.date);
    });

    it("removes a published workout, after which it is unknown", async () => {
      const publisher = makePublisher();
      const { remoteId } = await publisher.publish(input);
      await expect(publisher.remove(remoteId)).resolves.toBeUndefined();
      await expect(publisher.remove(remoteId)).rejects.toBeInstanceOf(PublisherNotFoundError);
    });

    it("reschedule of an unknown id fails typed", async () => {
      await expect(makePublisher().reschedule("424242", "2026-03-09")).rejects.toBeInstanceOf(
        PublisherNotFoundError,
      );
    });

    it("remove of an unknown id fails typed", async () => {
      await expect(makePublisher().remove("424242")).rejects.toBeInstanceOf(PublisherNotFoundError);
    });

    it("malformed ids fail typed, not with a raw error", async () => {
      const publisher = makePublisher();
      await expect(publisher.remove("not-an-id")).rejects.toBeInstanceOf(PublisherError);
      await expect(publisher.reschedule("not-an-id", "2026-03-09")).rejects.toBeInstanceOf(
        PublisherError,
      );
    });

    it("errors carry no secrets", async () => {
      const error = await makePublisher()
        .remove("424242")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PublisherError);
      const text = `${String(error)} ${JSON.stringify(error)}`;
      for (const secret of options.secrets ?? []) expect(text).not.toContain(secret);
    });
  });
}
