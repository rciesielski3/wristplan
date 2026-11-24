import Link from "next/link";
import type { KpiTile } from "../modules/analytics";
import { CHIP_LABEL, type StripDay, type TodayCard } from "../modules/calendar";
import type { ChecklistView, StepState } from "../modules/setup";

const STATE_MARK: Record<StepState, string> = { done: "✓", todo: "○", blocked: "–" };
const STATE_TEXT: Record<StepState, string> = { done: "Done", todo: "To do", blocked: "Blocked" };

export function Checklist({ view }: { view: ChecklistView }) {
  return (
    <section className="card" aria-labelledby="checklist-h">
      <h2 id="checklist-h">Get started</h2>
      <p>
        <strong>{view.progress}</strong> steps done
      </p>
      <progress value={view.done} max={view.total} aria-label="Setup progress" />
      <ol className="checklist">
        {view.steps.map((s) => (
          <li key={s.id} className={`step step-${s.state}`}>
            <span aria-hidden="true">{STATE_MARK[s.state]}</span> <strong>{s.title}</strong>{" "}
            <span className="badge">{STATE_TEXT[s.state]}</span>
            <div>{s.href ? <Link href={s.href}>{s.hint}</Link> : s.hint}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Today({ card }: { card: TodayCard }) {
  return (
    <section className="card" aria-labelledby="today-h">
      <h2 id="today-h">{card.heading}</h2>
      {card.items.length === 0 ? (
        <p>
          Nothing planned. <Link href="/calendar">Schedule a workout</Link>
        </p>
      ) : (
        <ul className="plain">
          {card.items.map((i) => (
            <li key={i.id}>
              <strong>{i.name}</strong> <span className="badge">{CHIP_LABEL[i.chip]}</span>
              {i.summary ? <div>{i.summary}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WeekStrip({ days }: { days: readonly StripDay[] }) {
  return (
    <section aria-labelledby="week-h">
      <h2 id="week-h">This week</h2>
      <ol className="strip">
        {days.map((d) => (
          <li key={d.date} className={d.isToday ? "today" : undefined}>
            <strong>{d.weekday}</strong>
            <span>{d.date.slice(5)}</span>
            <span>Planned {d.planned}</span>
            <span>Done {d.completed}</span>
            <span className="badge">{d.chip ? CHIP_LABEL[d.chip] : "—"}</span>
          </li>
        ))}
      </ol>
      <p>Weeks run Monday to Sunday; "today" is the server's local day.</p>
    </section>
  );
}

export function Kpis({
  tiles,
  notices,
}: {
  tiles: readonly KpiTile[];
  notices: readonly string[];
}) {
  return (
    <section aria-labelledby="kpi-h">
      <h2 id="kpi-h">Last 8 weeks</h2>
      <dl className="kpis">
        {tiles.map((t) => (
          <div key={t.label}>
            <dt>{t.label}</dt>
            <dd>{t.value}</dd>
          </div>
        ))}
      </dl>
      {notices.map((n) => (
        <p key={n} role="status">
          {n}
        </p>
      ))}
    </section>
  );
}
