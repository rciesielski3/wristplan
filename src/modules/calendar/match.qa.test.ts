import { describe, expect, it } from "vitest";
import { type MatchActivity, type MatchScheduled, matchWorkouts, type WorkoutSport } from "./match";

// WorkoutSport is currently only "run"; other sports are cast so the grouping stays covered when more are added.
const otherSport = (s: string): WorkoutSport => s as WorkoutSport;

// Deterministic mulberry32 PRNG so failures are reproducible.
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

const NASTY_IDS = [
  "",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  " ",
  "x".repeat(5000),
];
const DAYS = ["2030-01-01", "2030-01-02", "2030-01-03", ""];
const TYPE_KEYS = [
  "running",
  " Running ",
  "RUNNING",
  "cycling",
  "trail_running",
  "",
  null,
  "__proto__",
];
const BASE = Date.UTC(2030, 0, 1);

interface Gen {
  scheduled: MatchScheduled[];
  activities: MatchActivity[];
}

const generate = (seed: number, nS: number, nA: number): Gen => {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const aIds = new Set<string>();
  const sIds = new Set<string>();
  const uniq = (set: Set<string>, prefix: string, i: number) => {
    // Mix nasty ids in, but guarantee uniqueness within each collection.
    let id = r() < 0.15 ? pick(NASTY_IDS) : `${prefix}${i}`;
    while (set.has(id)) id = `${id}~${set.size}`;
    set.add(id);
    return id;
  };
  const activities: MatchActivity[] = [];
  for (let i = 0; i < nA; i++) {
    activities.push({
      id: uniq(aIds, "a", i),
      day: pick(DAYS),
      typeKey: pick(TYPE_KEYS),
      // Few distinct values so equal startTime ties are frequent.
      startTime: new Date(BASE + Math.floor(r() * 4) * 3_600_000),
    });
  }
  const aList = [...aIds];
  const scheduled: MatchScheduled[] = [];
  for (let i = 0; i < nS; i++) {
    const roll = r();
    scheduled.push({
      id: uniq(sIds, "s", i),
      date: pick(DAYS),
      sport: otherSport(pick(["run", "bike", "swim", "strength"])),
      createdAt: new Date(BASE + Math.floor(r() * 4) * 1000),
      // Links may be dangling, valid, or shared by several plans.
      link: roll < 0.3 ? (r() < 0.8 && aList.length ? pick(aList) : "dangling") : null,
      matchSource: roll < 0.15 ? "manual" : roll < 0.3 ? (r() < 0.5 ? "none" : "manual") : null,
    });
  }
  return { scheduled, activities };
};

const shuffle = <T>(xs: readonly T[], r: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const typeKeyToRun = (k: string | null) => k !== null && k.trim().toLowerCase() === "running";

const checkInvariants = ({ scheduled, activities }: Gen) => {
  const res = matchWorkouts(scheduled, activities);
  const sById = new Map(scheduled.map((s) => [s.id, s]));
  const aById = new Map(activities.map((a) => [a.id, a]));

  const sSeen = [...res.pairs.map((p) => p.scheduledId), ...res.unmatchedScheduled].sort();
  expect(sSeen).toEqual(scheduled.map((s) => s.id).sort());
  const aSeen = [...res.pairs.map((p) => p.activityId), ...res.unmatchedActivities].sort();
  expect(aSeen).toEqual(activities.map((a) => a.id).sort());

  for (const p of res.pairs) {
    const s = sById.get(p.scheduledId);
    const a = aById.get(p.activityId);
    expect(s).toBeDefined();
    expect(a).toBeDefined();
    if (!s || !a) continue;
    expect(s.matchSource).not.toBe("none");
    if (p.source === "auto") {
      expect(a.day).toBe(s.date);
      // Only "running" maps to a sport today, and it maps to "run".
      expect(s.sport).toBe("run");
      expect(typeKeyToRun(a.typeKey)).toBe(true);
    } else {
      expect(s.link).toBe(a.id);
    }
  }
  return res;
};

describe("matchWorkouts properties (seeded)", () => {
  it("holds partition, pairing and link invariants on 300 random inputs", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = prng(seed * 7919);
      checkInvariants(generate(seed, Math.floor(r() * 25), Math.floor(r() * 25)));
    }
  });

  it("is identical under random permutations of both arrays", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = generate(seed + 1000, 20, 20);
      const base = matchWorkouts(g.scheduled, g.activities);
      const r = prng(seed);
      for (let k = 0; k < 5; k++) {
        const out = matchWorkouts(shuffle(g.scheduled, r), shuffle(g.activities, r));
        expect(out).toEqual(base);
      }
    }
  });

  it("is idempotent and does not mutate its inputs", () => {
    const g = generate(42, 30, 30);
    const sCopy = structuredClone(g.scheduled);
    const aCopy = structuredClone(g.activities);
    const first = matchWorkouts(g.scheduled, g.activities);
    expect(matchWorkouts(g.scheduled, g.activities)).toEqual(first);
    expect(g.scheduled).toEqual(sCopy);
    expect(g.activities).toEqual(aCopy);
  });
});

describe("matchWorkouts adversarial cases", () => {
  const sch = (id: string, over: Partial<MatchScheduled> = {}): MatchScheduled => ({
    id,
    date: "2030-01-01",
    sport: "run",
    createdAt: new Date(BASE),
    link: null,
    matchSource: null,
    ...over,
  });
  const act = (id: string, over: Partial<MatchActivity> = {}): MatchActivity => ({
    id,
    day: "2030-01-01",
    typeKey: "running",
    startTime: new Date(BASE),
    ...over,
  });

  it("survives prototype-like and empty ids without polluting Object.prototype", () => {
    const ids = ["__proto__", "constructor", "toString", ""];
    const res = matchWorkouts(
      ids.map((id) => sch(id)),
      ids.map((id) => act(id)),
    );
    expect(res.pairs).toHaveLength(4);
    expect(res.unmatchedScheduled).toEqual([]);
    expect(({} as Record<string, unknown>).scheduledId).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("links to an activity whose id is __proto__", () => {
    const res = matchWorkouts(
      [
        sch("s", {
          link: "__proto__",
          matchSource: "manual",
          date: "1999-01-01",
          sport: otherSport("swim"),
        }),
      ],
      [act("__proto__", { day: "2030-05-05", typeKey: "cycling" })],
    );
    expect(res.pairs).toEqual([{ scheduledId: "s", activityId: "__proto__", source: "manual" }]);
  });

  it("handles very long ids", () => {
    const long = "z".repeat(100_000);
    const res = matchWorkouts([sch(long)], [act(long)]);
    expect(res.pairs).toEqual([{ scheduledId: long, activityId: long, source: "auto" }]);
  });

  it("does not auto-match plans with a non-run sport even when typeKey is running", () => {
    const res = matchWorkouts([sch("s", { sport: otherSport("bike") })], [act("a")]);
    expect(res.pairs).toEqual([]);
    expect(res.unmatchedActivities).toEqual(["a"]);
  });

  it("does not match odd typeKeys that merely contain running", () => {
    const res = matchWorkouts(
      [sch("s")],
      [
        act("a1", { typeKey: "running_" }),
        act("a2", { typeKey: "run" }),
        act("a3", { typeKey: "run ning" }),
      ],
    );
    expect(res.pairs).toEqual([]);
  });

  it("a claim loser does not auto-match a different free activity", () => {
    const res = matchWorkouts(
      [
        sch("w", { link: "a", matchSource: "manual", createdAt: new Date(BASE) }),
        sch("l", { link: "a", matchSource: "manual", createdAt: new Date(BASE + 1) }),
      ],
      [act("a"), act("b")],
    );
    expect(res.pairs.map((p) => p.scheduledId)).toEqual(["w"]);
    expect(res.unmatchedScheduled).toEqual(["l"]);
    expect(res.unmatchedActivities).toEqual(["b"]);
  });

  it("orders plans created at the epoch and far-future dates deterministically", () => {
    const s = [
      sch("b", { createdAt: new Date(0) }),
      sch("a", { createdAt: new Date(8.64e15) }),
      sch("c", { createdAt: new Date(-8.64e15) }),
    ];
    const a = [
      act("x", { startTime: new Date(8.64e15) }),
      act("y", { startTime: new Date(-8.64e15) }),
      act("z", { startTime: new Date(0) }),
    ];
    const res = matchWorkouts(s, a);
    expect(res.pairs.map((p) => `${p.scheduledId}>${p.activityId}`)).toEqual(["a>x", "b>z", "c>y"]);
    expect(res).toEqual(matchWorkouts([...s].reverse(), [...a].reverse()));
  });

  it("handles 2000 plans x 2000 activities", () => {
    const s: MatchScheduled[] = [];
    const a: MatchActivity[] = [];
    for (let i = 0; i < 2000; i++) {
      s.push(
        sch(`s${i}`, {
          date: `2030-01-${String((i % 28) + 1).padStart(2, "0")}`,
          createdAt: new Date(BASE + i),
        }),
      );
      a.push(
        act(`a${i}`, {
          day: `2030-01-${String((i % 28) + 1).padStart(2, "0")}`,
          startTime: new Date(BASE + i),
        }),
      );
    }
    const res = matchWorkouts(s, a);
    expect(res.pairs).toHaveLength(2000);
  });
});
