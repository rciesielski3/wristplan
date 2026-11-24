import Link from "next/link";
import { connection } from "next/server";
import { getDb } from "../../lib/db";
import { formatDuration, formatText } from "../../modules/activities";
import {
  createWorkoutRepository,
  type StoredWorkout,
  summarizeWorkout,
} from "../../modules/workouts";
import { requireAllowedHost } from "../workoutDeps";
import { WorkoutActions } from "./WorkoutActions";

const TARGET_LABEL = { hr: "Heart rate", pace: "Pace", power: "Power" } as const;

function WorkoutTable({ title, items }: { title: string; items: readonly StoredWorkout[] }) {
  return (
    <section>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Sport</th>
                <th>Steps</th>
                <th>Duration</th>
                <th>Target</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const sum = summarizeWorkout(s.workout);
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/workouts/${s.id}/edit`}>{formatText(s.workout.name)}</Link>
                    </td>
                    <td>{s.workout.sport}</td>
                    <td>{sum.stepCount}</td>
                    <td>{sum.totalSeconds === null ? "—" : formatDuration(sum.totalSeconds)}</td>
                    <td>{TARGET_LABEL[sum.targetType]}</td>
                    <td>
                      <WorkoutActions id={s.id} name={s.workout.name} isTemplate={s.isTemplate} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function Page() {
  await connection();
  await requireAllowedHost();
  const { items, corruptIds } = await createWorkoutRepository(getDb()).list();
  return (
    <div>
      <h1>Workouts</h1>
      <p>
        <Link href="/workouts/new">New workout</Link>
      </p>
      {corruptIds.length > 0 ? (
        <p role="alert">{corruptIds.length} stored workout(s) could not be read and are hidden.</p>
      ) : null}
      <WorkoutTable title="Workouts" items={items.filter((i) => !i.isTemplate)} />
      <WorkoutTable title="Templates" items={items.filter((i) => i.isTemplate)} />
    </div>
  );
}
