import { connection } from "next/server";
import { emptyForm } from "../../../modules/workouts";
import { requireAllowedHost } from "../../workoutDeps";
import { WorkoutBuilder } from "../WorkoutBuilder";

export default async function Page() {
  await connection();
  await requireAllowedHost();
  return (
    <div>
      <h1>New workout</h1>
      <WorkoutBuilder initial={emptyForm()} />
    </div>
  );
}
