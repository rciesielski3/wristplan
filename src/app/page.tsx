import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getDb } from "../lib/db";
import { getEnv } from "../lib/env";
import {
  formatDistance,
  formatDuration,
  formatText,
  formatTimestamp,
  isHostAllowed,
  latestSyncRun,
  listActivities,
} from "../modules/activities";
import { SyncButton } from "./SyncButton";

export default async function Page() {
  await connection();
  if (!isHostAllowed((await headers()).get("host"), getEnv().ALLOWED_HOSTS)) notFound();
  const db = getDb();
  const [activities, run] = await Promise.all([listActivities(db), latestSyncRun(db)]);

  return (
    <main>
      <h1>wristplan</h1>
      <p>Plan workouts and sync them to your watch.</p>

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
        )}
      </section>
    </main>
  );
}
