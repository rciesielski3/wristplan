import { describe, expect, it } from "vitest";
import { activitySport, type MatchActivity, type MatchScheduled, matchWorkouts } from "./match";

const sch = (id: string, over: Partial<MatchScheduled> = {}): MatchScheduled => ({
  id,
  date: "2030-01-01",
  sport: "run",
  createdAt: new Date("2030-01-01T00:00:00Z"),
  link: null,
  matchSource: null,
  ...over,
});

const act = (id: string, over: Partial<MatchActivity> = {}): MatchActivity => ({
  id,
  day: "2030-01-01",
  typeKey: "running",
  startTime: new Date("2030-01-01T08:00:00Z"),
  ...over,
});

const ids = (r: ReturnType<typeof matchWorkouts>) =>
  r.pairs.map((p) => `${p.scheduledId}>${p.activityId}:${p.source}`);

describe("activitySport", () => {
  it.each([
    ["running", "run"],
    ["  Running ", "run"],
    ["RUNNING", "run"],
    [null, null],
    ["", null],
    ["cycling", null],
    ["trail_running", null],
    ["constructor", null],
    ["unknown_thing", null],
  ])("%j -> %j", (input, expected) => {
    expect(activitySport(input)).toBe(expected);
  });
});

describe("matchWorkouts", () => {
  it("handles empty inputs", () => {
    expect(matchWorkouts([], [])).toEqual({
      pairs: [],
      unmatchedScheduled: [],
      unmatchedActivities: [],
    });
  });

  it("matches one plan to one activity on the same day", () => {
    const r = matchWorkouts([sch("s1")], [act("a1")]);
    expect(ids(r)).toEqual(["s1>a1:auto"]);
    expect(r.unmatchedScheduled).toEqual([]);
    expect(r.unmatchedActivities).toEqual([]);
  });

  it("does not match across days", () => {
    const r = matchWorkouts([sch("s1")], [act("a1", { day: "2030-01-02" })]);
    expect(r.pairs).toEqual([]);
    expect(r.unmatchedScheduled).toEqual(["s1"]);
    expect(r.unmatchedActivities).toEqual(["a1"]);
  });

  it("does not match unknown or other sports", () => {
    const r = matchWorkouts(
      [sch("s1")],
      [act("a1", { typeKey: "cycling" }), act("a2", { typeKey: null })],
    );
    expect(r.pairs).toEqual([]);
    expect(r.unmatchedActivities).toEqual(["a1", "a2"]);
  });

  it("2 plans / 1 activity: earliest plan wins", () => {
    const r = matchWorkouts(
      [
        sch("s2", { createdAt: new Date("2030-01-01T02:00:00Z") }),
        sch("s1", { createdAt: new Date("2030-01-01T01:00:00Z") }),
      ],
      [act("a1")],
    );
    expect(ids(r)).toEqual(["s1>a1:auto"]);
    expect(r.unmatchedScheduled).toEqual(["s2"]);
  });

  it("1 plan / 2 activities: earliest activity wins", () => {
    const r = matchWorkouts(
      [sch("s1")],
      [
        act("a1", { startTime: new Date("2030-01-01T18:00:00Z") }),
        act("a2", { startTime: new Date("2030-01-01T07:00:00Z") }),
      ],
    );
    expect(ids(r)).toEqual(["s1>a2:auto"]);
    expect(r.unmatchedActivities).toEqual(["a1"]);
  });

  it("2 plans / 2 activities pair by order", () => {
    const r = matchWorkouts(
      [
        sch("s1", { createdAt: new Date("2030-01-01T01:00:00Z") }),
        sch("s2", { createdAt: new Date("2030-01-01T02:00:00Z") }),
      ],
      [
        act("a1", { startTime: new Date("2030-01-01T18:00:00Z") }),
        act("a2", { startTime: new Date("2030-01-01T07:00:00Z") }),
      ],
    );
    expect(ids(r)).toEqual(["s1>a2:auto", "s2>a1:auto"]);
  });

  it("keeps mixed sports on one day separate", () => {
    const r = matchWorkouts(
      [sch("s1")],
      [act("a1", { typeKey: "cycling" }), act("a2", { typeKey: "running" })],
    );
    expect(ids(r)).toEqual(["s1>a2:auto"]);
    expect(r.unmatchedActivities).toEqual(["a1"]);
  });

  it("manual link crosses day and sport", () => {
    const r = matchWorkouts(
      [sch("s1", { link: "a1", matchSource: "manual" })],
      [act("a1", { day: "2030-02-01", typeKey: "cycling" })],
    );
    expect(ids(r)).toEqual(["s1>a1:manual"]);
  });

  it("manual link wins over auto and frees the auto candidate", () => {
    const r = matchWorkouts(
      [
        sch("s1", { createdAt: new Date("2030-01-01T01:00:00Z") }),
        sch("s2", {
          createdAt: new Date("2030-01-01T02:00:00Z"),
          link: "a2",
          matchSource: "manual",
        }),
      ],
      [
        act("a1", { startTime: new Date("2030-01-01T07:00:00Z") }),
        act("a2", { startTime: new Date("2030-01-01T08:00:00Z") }),
      ],
    );
    expect(ids(r)).toEqual(["s1>a1:auto", "s2>a2:manual"]);
  });

  it("manual link steals the activity an earlier plan would auto-match", () => {
    const r = matchWorkouts(
      [
        sch("s1", { createdAt: new Date("2030-01-01T01:00:00Z") }),
        sch("s2", {
          createdAt: new Date("2030-01-01T02:00:00Z"),
          link: "a1",
          matchSource: "manual",
        }),
      ],
      [act("a1")],
    );
    expect(ids(r)).toEqual(["s2>a1:manual"]);
    expect(r.unmatchedScheduled).toEqual(["s1"]);
  });

  it("matchSource none suppresses auto and leaves the activity unplanned", () => {
    const r = matchWorkouts([sch("s1", { matchSource: "none" })], [act("a1")]);
    expect(r.pairs).toEqual([]);
    expect(r.unmatchedScheduled).toEqual(["s1"]);
    expect(r.unmatchedActivities).toEqual(["a1"]);
  });

  it("matchSource none ignores a link", () => {
    const r = matchWorkouts([sch("s1", { matchSource: "none", link: "a1" })], [act("a1")]);
    expect(r.pairs).toEqual([]);
  });

  it("ignores a dangling link and falls back to auto", () => {
    const r = matchWorkouts([sch("s1", { link: "gone", matchSource: "manual" })], [act("a1")]);
    expect(ids(r)).toEqual(["s1>a1:auto"]);
  });

  it("two claims on one activity: earlier (createdAt, id) wins, loser unmatched", () => {
    const r = matchWorkouts(
      [
        sch("s2", {
          createdAt: new Date("2030-01-01T02:00:00Z"),
          link: "a1",
          matchSource: "manual",
        }),
        sch("s1", {
          createdAt: new Date("2030-01-01T01:00:00Z"),
          link: "a1",
          matchSource: "manual",
        }),
      ],
      [act("a1"), act("a2")],
    );
    expect(ids(r)).toEqual(["s1>a1:manual"]);
    expect(r.unmatchedScheduled).toEqual(["s2"]);
    expect(r.unmatchedActivities).toEqual(["a2"]);
  });

  it("breaks createdAt ties by id", () => {
    const r = matchWorkouts([sch("sB"), sch("sA")], [act("a1")]);
    expect(ids(r)).toEqual(["sA>a1:auto"]);
    expect(r.unmatchedScheduled).toEqual(["sB"]);
  });

  it("breaks startTime ties by id", () => {
    const r = matchWorkouts([sch("s1")], [act("aB"), act("aA")]);
    expect(ids(r)).toEqual(["s1>aA:auto"]);
  });

  it("is independent of input order", () => {
    const s = [
      sch("s1", { createdAt: new Date("2030-01-01T01:00:00Z") }),
      sch("s2", { createdAt: new Date("2030-01-01T02:00:00Z"), link: "a9", matchSource: "manual" }),
      sch("s3", { date: "2030-01-02" }),
      sch("s4", { matchSource: "none" }),
      sch("s5"),
    ];
    const a = [
      act("a1", { startTime: new Date("2030-01-01T07:00:00Z") }),
      act("a2", { startTime: new Date("2030-01-01T08:00:00Z") }),
      act("a3", { day: "2030-01-02" }),
      act("a9", { typeKey: "cycling" }),
      act("a4", { typeKey: null }),
    ];
    const expected = matchWorkouts(s, a);
    expect(ids(expected)).toEqual(["s1>a2:auto", "s2>a9:manual", "s3>a3:auto", "s5>a1:auto"]);
    expect(matchWorkouts([...s].reverse(), [...a].reverse())).toEqual(expected);
    expect(
      matchWorkouts(
        [s[3], s[0], s[4], s[2], s[1]].filter((x) => x !== undefined),
        [a[2], a[4], a[0], a[3], a[1]].filter((x) => x !== undefined),
      ),
    ).toEqual(expected);
  });
});
