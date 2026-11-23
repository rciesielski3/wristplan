import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY_MS,
  daysFromIso,
  isoFromDays,
  mulberry32,
  oraclePeriods,
} from "../../../test/analytics-oracle";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher } from "../../../test/fake-publisher";
import { buildGrid, createScheduleService, loadCalendar, matchWorkouts } from "../calendar";
import { createWorkoutRepository } from "../workouts";
import { loadDashboard } from "./load";

type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const ANCHORS = [
  "2026-06-17",
  "2026-03-01", // Sunday, month start
  "2026-03-31",
  "2026-01-01", // year boundary
  "2026-12-31",
  "2024-02-29", // leap day
  "2026-06-15", // Monday
  "2026-06-21", // Sunday
];
const SHAPES = [
  { kind: "week", count: 4 },
  { kind: "week", count: 8 },
  { kind: "month", count: 3 },
  { kind: "month", count: 6 },
] as const;
const SPORTS = ["running", "running", "running", " Running ", "cycling", "trail_running", null];
const TIMES = ["00:00:00.000", "23:59:59.999", "00:00:00.001", "12:30:00.000", "23:59:59.998"];
const POOL = 10;
const CORRUPT = new Set([3, 7]);

describe("loadDashboard parity with loadCalendar and matchWorkouts (seeded)", () => {
  let t: TestDb;
  let definition = "";
  beforeAll(async () => {
    t = createTestDb();
    const w = await createWorkoutRepository(t.db).create({
      name: "Pool",
      sport: "run",
      steps: [
        { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
      ],
    });
    definition = (await t.db.workout.findUniqueOrThrow({ where: { id: w.id } })).definition;
    await t.db.workout.delete({ where: { id: w.id } });
  });
  afterAll(() => t.cleanup());

  async function dataset(seed: number) {
    const rng = mulberry32(seed);
    const { kind, count } = pick(rng, SHAPES);
    const anchor = pick(rng, ANCHORS);
    const periods = oraclePeriods(kind, anchor, count);
    const from = periods[0]?.start as string;
    const to = periods[periods.length - 1]?.end as string;
    const fromDay = daysFromIso(from);
    const toDay = daysFromIso(to);
    const span = toDay - fromDay + 1;
    const today = isoFromDays(fromDay + int(rng, -2, span + 2));

    await t.db.scheduledWorkout.deleteMany();
    await t.db.activity.deleteMany();
    await t.db.workout.deleteMany();
    await t.db.workout.createMany({
      data: Array.from({ length: POOL }, (_, i) => ({
        id: `wk${i}`,
        definition: CORRUPT.has(i) ? "{" : definition,
      })),
    });

    const nAct = int(rng, 0, Math.min(150, span * 2));
    const acts = Array.from({ length: nAct }, (_, i) => {
      const day = fromDay + int(rng, -6, span + 5);
      return {
        garminActivityId: `act${i}`,
        startTime: new Date(`${isoFromDays(day)}T${pick(rng, TIMES)}Z`),
        lastSyncedAt: new Date(0),
        sport: pick(rng, SPORTS),
        durationSeconds: rng() < 0.25 ? null : int(rng, 60, 7200),
        distanceMeters: rng() < 0.25 ? null : int(rng, 100, 40000),
      };
    });
    await t.db.activity.createMany({ data: acts });

    const nPlans = int(rng, 0, Math.min(200, span * 3));
    const seen = new Set<string>();
    const usedLinks = new Set<string>();
    const plans: {
      workoutId: string;
      date: string;
      status: string;
      externalId: string;
      createdAt: Date;
      matchSource: string | null;
      linkedGarminActivityId: string | null;
    }[] = [];
    for (let i = 0; i < nPlans; i++) {
      const date = isoFromDays(fromDay + int(rng, -4, span + 3));
      const workoutId = `wk${int(rng, 0, POOL - 1)}`;
      if (seen.has(`${workoutId}|${date}`)) continue;
      seen.add(`${workoutId}|${date}`);
      const matchSource = pick(rng, [null, null, "manual", "manual", "manual", "none", "weird"]);
      let link: string | null = null;
      if (matchSource !== "none" && rng() < 0.8) {
        const candidate =
          rng() < 0.2 || acts.length === 0
            ? `ghost${i}`
            : (pick(rng, acts).garminActivityId as string);
        if (!usedLinks.has(candidate)) {
          usedLinks.add(candidate);
          link = candidate;
        }
      }
      plans.push({
        workoutId,
        date,
        status: "published",
        externalId: `wristplan-p${i}`,
        createdAt: new Date(1_700_000_000_000 + int(rng, 0, 5) * 1000),
        matchSource,
        linkedGarminActivityId: link,
      });
    }
    await t.db.scheduledWorkout.createMany({ data: plans });
    return { kind, count, anchor, periods, from, to, today, acts, plans };
  }

  it("agrees on matched and due for 120 random datasets", async () => {
    let sawMatched = 0;
    let sawManualOutside = 0;
    let sawMissing = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const ds = await dataset(seed);
      const msg = `seed ${seed} ${ds.kind}/${ds.count}@${ds.anchor} today=${ds.today}`;

      const dash = await loadDashboard(
        t.db,
        { kind: ds.kind, count: ds.count, anchor: ds.anchor },
        ds.today,
      );
      expect(dash.partial, msg).toBe(false);
      expect(dash.periodSet.from, msg).toBe(ds.from);
      expect(dash.periodSet.to, msg).toBe(ds.to);
      const report = dash.plans;
      if (!report) throw new Error(`plans null: ${msg}`);

      // 1. Independent recomputation from the calendar loader's items.
      const grid = { ...buildGrid("week", ds.anchor), from: ds.from, to: ds.to };
      const cal = await loadCalendar(
        t.db,
        () => createScheduleService({ db: t.db, publisher: createFakePublisher() }),
        grid,
        ds.today,
      );
      expect(cal.notices, msg).toEqual([]);
      const items = Object.values(cal.days).flatMap((d) => d.scheduled);
      const calMatched = new Array(ds.periods.length).fill(0);
      const calDue = new Array(ds.periods.length).fill(0);
      const calUpcoming = new Array(ds.periods.length).fill(0);
      for (const it of items) {
        const day = daysFromIso(it.date);
        const idx = ds.periods.findIndex((p) => day >= p.startDay && day <= p.endDay);
        if (idx < 0) continue;
        // "Unavailable workout" rows have an empty summary.
        const available = it.summary !== "";
        if (it.date > ds.today) calUpcoming[idx] += 1;
        else if (available && it.matchSource !== "none") {
          calDue[idx] += 1;
          if (it.state === "matched") calMatched[idx] += 1;
        }
      }

      // 2. Direct matchWorkouts on raw rows with an independent day computation.
      const rows = await t.db.scheduledWorkout.findMany({
        where: { date: { gte: ds.from, lte: ds.to } },
      });
      const fromDay0 = daysFromIso(ds.from);
      const toDay0 = daysFromIso(ds.to);
      const inRange = (a: { startTime: Date }) => {
        const d = Math.floor(a.startTime.getTime() / DAY_MS);
        return d >= fromDay0 && d <= toDay0;
      };
      const links = new Set(
        rows
          .filter((r) => r.matchSource === "manual" && r.linkedGarminActivityId !== null)
          .map((r) => r.linkedGarminActivityId as string),
      );
      const rawActs = (await t.db.activity.findMany()).filter(
        (a) => inRange(a) || links.has(a.garminActivityId),
      );
      const usable = rows.filter((r) => !CORRUPT.has(Number(r.workoutId.slice(2))));
      const direct = matchWorkouts(
        usable.map((r) => ({
          id: r.id,
          date: r.date,
          sport: "run" as const,
          createdAt: r.createdAt,
          link: r.matchSource === "manual" ? r.linkedGarminActivityId : null,
          matchSource:
            r.matchSource === "manual" || r.matchSource === "none" ? r.matchSource : null,
        })),
        rawActs.map((a) => ({
          id: a.garminActivityId,
          day: isoFromDays(Math.floor(a.startTime.getTime() / DAY_MS)),
          typeKey: a.sport,
          startTime: a.startTime,
        })),
      );
      const pairedIds = new Set(direct.pairs.map((p) => p.scheduledId));
      const dirMatched = new Array(ds.periods.length).fill(0);
      const dirDue = new Array(ds.periods.length).fill(0);
      for (const r of usable) {
        if (r.date > ds.today || r.matchSource === "none") continue;
        const day = daysFromIso(r.date);
        const idx = ds.periods.findIndex((p) => day >= p.startDay && day <= p.endDay);
        dirDue[idx] += 1;
        if (pairedIds.has(r.id)) dirMatched[idx] += 1;
      }

      expect(
        report.perPeriod.map((p) => p.matched),
        `${msg} matched vs calendar`,
      ).toEqual(calMatched);
      expect(
        report.perPeriod.map((p) => p.due),
        `${msg} due vs calendar`,
      ).toEqual(calDue);
      expect(
        report.perPeriod.map((p) => p.upcoming),
        `${msg} upcoming vs calendar`,
      ).toEqual(calUpcoming);
      expect(
        report.perPeriod.map((p) => p.matched),
        `${msg} matched vs direct`,
      ).toEqual(dirMatched);
      expect(
        report.perPeriod.map((p) => p.due),
        `${msg} due vs direct`,
      ).toEqual(dirDue);
      expect(report.overall.matched, msg).toBe(calMatched.reduce((a, b) => a + b, 0));

      sawMatched += report.overall.matched;
      sawMissing += items.filter((i) => i.linkMissing).length;
      sawManualOutside += direct.pairs.filter(
        (p) =>
          p.source === "manual" &&
          !inRange(
            rawActs.find((a) => a.garminActivityId === p.activityId) ?? { startTime: new Date(0) },
          ),
      ).length;
    }
    // The generator must actually exercise the interesting paths.
    expect(sawMatched).toBeGreaterThan(200);
    expect(sawManualOutside).toBeGreaterThan(5);
    expect(sawMissing).toBeGreaterThan(5);
  }, 60_000);
});
