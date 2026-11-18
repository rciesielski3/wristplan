import type { TargetType, Workout } from "./model";
import { workoutTargetType } from "./validate";

export interface WorkoutSummary {
  readonly stepCount: number;
  readonly totalSeconds: number | null;
  readonly targetType: TargetType;
}

export function summarizeWorkout(workout: Workout): WorkoutSummary {
  let stepCount = 0;
  let totalSeconds: number | null = 0;
  for (const step of workout.steps) {
    const leaves = step.kind === "repeat" ? step.steps : [step];
    const times = step.kind === "repeat" ? step.times : 1;
    for (const leaf of leaves) {
      stepCount += 1;
      if (leaf.end.type === "time" && totalSeconds !== null)
        totalSeconds += leaf.end.seconds * times;
      else totalSeconds = null;
    }
  }
  return { stepCount, totalSeconds, targetType: workoutTargetType(workout) };
}
