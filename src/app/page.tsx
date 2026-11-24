import { connection } from "next/server";
import { getDb } from "../lib/db";
import { getEnv } from "../lib/env";
import {
  formatDistance,
  formatDuration,
  formatText,
  formatTimestamp,
  latestSyncRun,
  listActivities,
} from "../modules/activities";
import { buildKpiTiles, loadDashboard } from "../modules/analytics";
import {
  buildTodayCard,
  buildWeekStrip,
  homeGrid,
  loadCalendar,
  localDay,
} from "../modules/calendar";
import { buildChecklist, getSetupStatus, loadSetupCounts } from "../modules/setup";
import { Checklist, Kpis, Today, WeekStrip } from "./HomeCards";
import { SyncButton } from "./SyncButton";
import { scheduleDeps } from "./scheduleDeps";
import { requireAllowedHost } from "./workoutDeps";

export default async function Page() {
  await connection();
  await requireAllowedHost();
  const db = getDb();
  const status = getSetupStatus(getEnv(), await loadSetupCounts(db));
  const checklist = buildChecklist(status);

  if (!status.databaseReady) {
    return (
      <div>
        <h1>wristplan</h1>
        <p>Plan workouts and sync them to your watch.</p>
        <Checklist view={checklist} />
      </div>
    );
  }

  const today = localDay(new Date());
  const [activities, run] = await Promise.all([listActivities(db), latestSyncRun(db)]);
  const overview =
    checklist.complete || status.activityCount > 0
      ? await Promise.all([
          loadCalendar(db, scheduleDeps().readService, homeGrid(today), today),
          loadDashboard(db, { kind: "week", count: 8, anchor: today }, today),
        ])
      : null;

  return (
    <div>
      <h1>wristplan</h1>
      <p>Plan workouts and sync them to your watch.</p>

      {checklist.complete ? null : <Checklist view={checklist} />}
      {overview ? (
        <>
          <Today card={buildTodayCard(overview[0], today)} />
          <WeekStrip days={buildWeekStrip(overview[0], today)} />
          <Kpis tiles={buildKpiTiles(overview[1])} notices={overview[1].notices} />
        </>
      ) : null}

      <section>
        <h2>Sync</h2>
        <p>
          Last sync:{" "}
          {run
            ? `${run.status} (${formatTimestamp(run.startedAt)}), ${run.imported} imported, ${run.updated} updated, ${run.failed} failed`
            : "—"}
        </p>
        <SyncButton />
      </section>

      <section>
        <h2>Activities</h2>
        {activities.length === 0 ? (
          <p>No activities yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sport</th>
                  <th>Start</th>
                  <th>Duration</th>
                  <th>Distance</th>
                  <th>Status</th>
                  <th>Last synced</th>
                  <th>FIT</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((a) => (
                  <tr key={a.garminActivityId}>
                    <td>{formatText(a.name)}</td>
                    <td>{formatText(a.sport)}</td>
                    <td>{formatTimestamp(a.startTime)}</td>
                    <td>{formatDuration(a.durationSeconds)}</td>
                    <td>{formatDistance(a.distanceMeters)}</td>
                    <td>{a.syncStatus}</td>
                    <td>{formatTimestamp(a.lastSyncedAt)}</td>
                    <td>
                      {a.fitDownloadedAt ? (
                        <a href={`/api/activities/${a.garminActivityId}/fit`}>Download</a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
