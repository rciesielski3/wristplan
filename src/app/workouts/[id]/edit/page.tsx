import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getDb } from "../../../../lib/db";
import {
  createWorkoutRepository,
  editableForm,
  WorkoutCorruptError,
  WorkoutNotFoundError,
} from "../../../../modules/workouts";
import { requireAllowedHost } from "../../../workoutDeps";
import { WorkoutActions } from "../../WorkoutActions";
import { WorkoutBuilder } from "../../WorkoutBuilder";

function CannotEdit({ id, name, corrupt }: { id: string; name: string; corrupt: boolean }) {
  return (
    <main>
      <h1>Edit workout</h1>
      <p role="alert">This workout cannot be edited in the builder.</p>
      <p>
        <Link href="/workouts">Back to workouts</Link>
      </p>
      <WorkoutActions
        id={id}
        name={name}
        isTemplate={false}
        corrupt={corrupt}
        redirectTo="/workouts"
      />
    </main>
  );
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  await requireAllowedHost();
  const { id } = await params;
  try {
    const stored = await createWorkoutRepository(getDb()).get(id);
    const form = editableForm(stored.workout);
    if (!form) return <CannotEdit id={stored.id} name={stored.workout.name} corrupt={false} />;
    return (
      <main>
        <h1>Edit workout</h1>
        <WorkoutBuilder id={stored.id} initial={form} />
      </main>
    );
  } catch (err) {
    if (err instanceof WorkoutCorruptError)
      return <CannotEdit id={id} name="this workout" corrupt />;
    if (err instanceof WorkoutNotFoundError) notFound();
    throw err;
  }
}
