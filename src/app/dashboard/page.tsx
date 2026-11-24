import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getDb } from "../../lib/db";
import { buildDashboardView, loadDashboard, parseDashboardQuery } from "../../modules/analytics";
import { localDay, parseAnchor } from "../../modules/calendar";
import { requireAllowedHost } from "../workoutDeps";

type Param = string | string[] | undefined;

const first = (value: Param) => (Array.isArray(value) ? value[0] : value);

function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be focusable for keyboard users
    <section className="scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: Param; n?: Param; date?: Param }>;
}) {
  await connection();
  await requireAllowedHost();
  const params = await searchParams;
  const today = localDay(new Date());
  const query = parseDashboardQuery(params.period, params.n);
  const anchor = parseAnchor(first(params.date), today);
  const data = await loadDashboard(getDb(), { ...query, anchor }, today);
  const view = buildDashboardView(data, query, anchor);
  const { nav, trend } = view;

  return (
    <div>
      <h1>Dashboard</h1>
      <p>
        Read-only statistics from stored activities and scheduled workouts. Nothing is sent
        anywhere.
      </p>

      <nav aria-label="Dashboard navigation">
        {nav.prev ? <Link href={nav.prev}>Previous</Link> : <span>Previous</span>}{" "}
        <Link href={nav.latest}>Latest</Link>{" "}
        {nav.next ? <Link href={nav.next}>Next</Link> : <span>Next</span>}{" "}
        {nav.kinds.map((k) => (
          <span key={k.label}>
            <Link href={k.href} aria-current={k.current ? "page" : undefined}>
              {k.label}
            </Link>{" "}
          </span>
        ))}
        {nav.counts.map((c) => (
          <span key={c.label}>
            <Link href={c.href} aria-current={c.current ? "page" : undefined}>
              {c.label}
            </Link>{" "}
          </span>
        ))}
      </nav>
      <p>Range: {view.range}</p>
      {view.notices.map((n) => (
        <p key={n} role="status">
          {n}
        </p>
      ))}

      <section aria-labelledby="volume-h">
        <h2 id="volume-h">Volume per sport</h2>
        {view.volume.empty ? (
          <p>No activities in this range.</p>
        ) : (
          <>
            <Scroll label="Volume per sport table">
              <table>
                <caption>Activities, duration and distance per sport and period</caption>
                <thead>
                  <tr>
                    <th scope="col">Sport</th>
                    {view.periodLabels.map((l) => (
                      <th key={l} scope="col">
                        {l}
                      </th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {view.volume.rows.map((r) => (
                    <tr key={r.label}>
                      <th scope="row">{r.label}</th>
                      {r.cells.map((c, i) => (
                        <td key={view.periodLabels[i]}>{c}</td>
                      ))}
                      <td>{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <p>Cells show activities · duration · distance.</p>
            {view.volume.hasUnknown ? (
              <p>
                &quot;n of m&quot; means only n of m activities have that value. Totals exclude
                activities without a duration/distance.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="plans-h">
        <h2 id="plans-h">Planned vs completed</h2>
        {view.plans === null ? (
          <p>Plan statistics are unavailable for this range.</p>
        ) : (
          <>
            <Scroll label="Planned vs completed table">
              <table>
                <caption>Planned workouts completed per period</caption>
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Upcoming</th>
                    <th scope="col">Excluded (No match marked)</th>
                    <th scope="col">Excluded (workout unavailable)</th>
                    <th scope="col">Planned vs actual duration (matched pairs)</th>
                  </tr>
                </thead>
                <tbody>
                  {view.plans.rows.map((r) => (
                    <tr key={r.label}>
                      <th scope="row">{r.label}</th>
                      <td>{r.completed}</td>
                      <td>{r.upcoming}</td>
                      <td>{r.excludedNoMatch}</td>
                      <td>{r.excludedUnavailable}</td>
                      <td>{r.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <p>
              Due means planned for today or earlier. Failed and pending plans count as due. Plans
              marked No match and plans whose workout is unavailable are excluded. Planned vs actual
              duration is based on matched pairs with a known planned and actual duration.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="trend-h">
        <h2 id="trend-h">Trend</h2>
        {trend === null ? (
          <p>Trend is unavailable because the data for this range is incomplete.</p>
        ) : (
          <>
            {trend.metrics.map(({ metric, title, caption }) => (
              <Scroll key={metric} label={`${title} trend table`}>
                <table>
                  <caption>{caption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Sport</th>
                      {trend.columns.map((l) => (
                        <th key={l} scope="col">
                          {l}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trend[metric].map((r) => (
                      <tr key={r.label}>
                        <th scope="row">{r.label}</th>
                        {r.cells.map((c, i) => (
                          <td key={trend.columns[i]}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            ))}
            <p>
              — means no comparison is possible (no previous volume, or activities without a
              duration/distance). The month view compares the running month with a full previous
              month.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="notes-h">
        <h2 id="notes-h">Notes</h2>
        <p>Trend metrics from Garmin (load, training effect, HR zones) are not stored.</p>
        <p>Last sync: {view.lastSync}</p>
        <p>
          Days are UTC and weeks run Monday to Sunday. &quot;Today&quot; is the server&apos;s local
          day.
        </p>
      </section>
    </div>
  );
}
