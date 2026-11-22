import Link from "next/link";
import { connection } from "next/server";
import { getDb } from "../../lib/db";
import { formatDistance, formatDuration } from "../../modules/activities";
import {
  type ActivityItem,
  buildGrid,
  type CalendarDay,
  type CalendarView,
  formatDelta,
  loadCalendar,
  localDay,
  parseAnchor,
  parseView,
  type ScheduledItem,
} from "../../modules/calendar";
import { scheduleDeps } from "../scheduleDeps";
import { requireAllowedHost } from "../workoutDeps";
import { ItemActions, LinkControls, ScheduleForm } from "./CalendarActions";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_LABEL = { pending: "Pending", published: "Published", failed: "Failed" } as const;
const NO_DAY: CalendarDay = { scheduled: [], activities: [] };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const href = (view: CalendarView, date?: string) =>
  `/calendar?view=${view}${date === undefined ? "" : `&date=${date}`}`;

const STATE_LABEL = {
  matched: "Matched",
  "no-match": "No match (set manually)",
  missed: "Planned, not done",
  planned: "Planned",
} as const;

const secondsText = (seconds: number | null) =>
  seconds === null ? "n/a" : formatDuration(seconds);

function Scheduled({ item }: { item: ScheduledItem }) {
  const { match } = item;
  return (
    <li className={`item item-${item.status}`}>
      <strong>{item.name}</strong>{" "}
      <span className={`badge badge-${item.status}`}>{STATUS_LABEL[item.status]}</span>{" "}
      <span className="badge">{match ? `Matched (${match.source})` : STATE_LABEL[item.state]}</span>
      {item.summary ? <div>{item.summary}</div> : null}
      {match ? (
        <div>
          Planned {secondsText(match.plannedSeconds)} vs actual{" "}
          {secondsText(match.activity.durationSeconds)},{" "}
          {formatDistance(match.activity.distanceMeters)}, delta {formatDelta(match.deltaSeconds)}
          <br />
          {match.activity.name} ({match.activity.sport}) on {match.date}
        </div>
      ) : null}
      {item.linkMissing ? <div>Linked activity not found.</div> : null}
      {item.status === "failed" ? (
        <div role="alert">Publishing failed{item.lastError ? `: ${item.lastError}` : ""}</div>
      ) : null}
      <ItemActions id={item.id} name={item.name} date={item.date} status={item.status} />
      <LinkControls
        id={item.id}
        name={item.name}
        matchSource={item.matchSource}
        candidates={item.linkCandidates}
      />
    </li>
  );
}

function Activity({ item }: { item: ActivityItem }) {
  return (
    <li className="item">
      <strong>{item.name}</strong> <span className="badge">Unplanned activity</span>
      <div>
        {item.sport}, {item.duration}, {item.distance}
      </div>
    </li>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[]; date?: string | string[] }>;
}) {
  await connection();
  await requireAllowedHost();
  const params = await searchParams;
  const today = localDay(new Date());
  const view = parseView(first(params.view));
  const grid = buildGrid(view, parseAnchor(first(params.date), today));
  const deps = scheduleDeps();
  const data = await loadCalendar(getDb(), deps.readService, grid, today);

  return (
    <main>
      <nav aria-label="Main">
        <Link href="/">Home</Link> <Link href="/workouts">Workouts</Link>
      </nav>
      <h1>Calendar</h1>
      <p>
        <strong>Publishes to your real intervals.icu account.</strong> Completed Garmin activities
        are matched to planned runs by day and sport, or linked manually. Matching ignores publish
        status; linking only changes wristplan&apos;s local data.
      </p>

      <section aria-label="Schedule a workout">
        <h2>Schedule a workout</h2>
        <ScheduleForm workouts={data.workouts} defaultDate={today} />
      </section>

      <section aria-label="Calendar view">
        <h2>{grid.label}</h2>
        <nav aria-label="Calendar navigation">
          <Link href={href(view, grid.prev)}>Previous</Link> <Link href={href(view)}>Today</Link>{" "}
          <Link href={href(view, grid.next)}>Next</Link>{" "}
          <Link
            href={href("week", grid.anchor)}
            aria-current={view === "week" ? "page" : undefined}
          >
            Week
          </Link>{" "}
          <Link
            href={href("month", grid.anchor)}
            aria-current={view === "month" ? "page" : undefined}
          >
            Month
          </Link>
        </nav>
        {data.notices.map((n) => (
          <p key={n} role="status">
            {n}
          </p>
        ))}
        <table className="calendar">
          <caption>
            {view === "week" ? "Week" : "Month"} of {grid.label}
          </caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((day) => {
                  const { scheduled, activities } = data.days[day] ?? NO_DAY;
                  const outside = grid.month !== null && !day.startsWith(grid.month);
                  return (
                    <td
                      key={day}
                      className={`${outside ? "outside" : ""} ${day === today ? "today" : ""}`}
                    >
                      <time dateTime={day}>{day}</time>
                      {day === today ? <span> (today)</span> : null}
                      {scheduled.length > 0 ? (
                        <ul aria-label={`Scheduled on ${day}`}>
                          {scheduled.map((s) => (
                            <Scheduled key={s.id} item={s} />
                          ))}
                        </ul>
                      ) : null}
                      {activities.length > 0 ? (
                        <ul aria-label={`Completed on ${day}`}>
                          {activities.map((a) => (
                            <Activity key={a.id} item={a} />
                          ))}
                        </ul>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
