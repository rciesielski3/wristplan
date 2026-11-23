import { describe, expect, it } from "vitest";
import { aggregatePlans, aggregateVolume, type VolumeActivity } from "./aggregate";
import { buildPeriods } from "./periods";

const prng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const SPORTS = ["running", " Running", "cycling", "trail_running", "", null, "__proto__"];
const DAY0 = Date.UTC(2028, 1, 1);
const dayOf = (offset: number) => new Date(DAY0 + offset * 86_400_000).toISOString().slice(0, 10);

describe("analytics properties (seeded)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`volume invariants, seed ${seed}`, () => {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const set = buildPeriods(pick(["week", "month"] as const), dayOf(Math.floor(rnd() * 90)), 4);
      const activities: VolumeActivity[] = Array.from({ length: Math.floor(rnd() * 60) }, () => ({
        day: dayOf(Math.floor(rnd() * 150) - 20),
        sport: pick(SPORTS),
        durationSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 7200) + rnd(),
        distanceMeters: rnd() < 0.2 ? null : Math.floor(rnd() * 20000) + rnd(),
      }));
      const inside = activities.filter((a) => a.day >= set.from && a.day <= set.to);
      const r = aggregateVolume(activities, set.periods);
      expect(r.overall.count).toBe(inside.length);
      expect(r.sports.reduce((n, s) => n + s.total.count, 0)).toBe(inside.length);
      expect(r.totals.reduce((n, t) => n + t.count, 0)).toBe(inside.length);
      r.totals.forEach((t, i) => {
        const sum = r.sports.reduce((n, s) => n + (s.perPeriod[i]?.count ?? 0), 0);
        expect(sum).toBe(t.count);
        expect(t.durationKnown).toBeLessThanOrEqual(t.count);
      });
      const shuffled = [...activities].sort(() => rnd() - 0.5);
      expect(aggregateVolume(shuffled, set.periods)).toEqual(r);
    });

    it(`plan invariants, seed ${seed}`, () => {
      const rnd = prng(seed + 1000);
      const set = buildPeriods("week", dayOf(40), 4);
      const today = dayOf(30 + Math.floor(rnd() * 20));
      const plans = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => ({
        id: `p${i}`,
        date: dayOf(Math.floor(rnd() * 70)),
        matchSource: (["manual", "none", null] as const)[Math.floor(rnd() * 3)] ?? null,
        workoutAvailable: rnd() < 0.8,
        plannedSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 5000),
      }));
      const pairs = plans
        .filter(() => rnd() < 0.5)
        .map((p) => ({
          scheduledId: p.id,
          actualSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 5000),
        }));
      const r = aggregatePlans(plans, pairs, set.periods, today);
      const inside = plans.filter((p) => p.date >= set.from && p.date <= set.to);
      const o = r.overall;
      expect(o.due + o.upcoming + o.excludedNoMatch + o.excludedUnavailable).toBe(inside.length);
      expect(o.matched).toBeLessThanOrEqual(o.due);
      expect(o.time.pairsWithBoth).toBeLessThanOrEqual(o.matched);
      if (o.ratio !== null) {
        expect(o.ratio).toBeGreaterThanOrEqual(0);
        expect(o.ratio).toBeLessThanOrEqual(1);
      }
      const shuffled = [...plans].sort(() => rnd() - 0.5);
      expect(aggregatePlans(shuffled, [...pairs].reverse(), set.periods, today)).toEqual(r);
    });
  }
});
