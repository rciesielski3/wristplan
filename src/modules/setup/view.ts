import { formatTimestamp } from "../activities";
import type { SetupStatus } from "./status";

export type StepState = "done" | "todo" | "blocked";

export interface ChecklistStep {
  readonly id: "database" | "garmin" | "intervals" | "sync" | "workout" | "schedule";
  readonly title: string;
  readonly state: StepState;
  readonly hint: string;
  readonly href: string | null;
}

export interface ChecklistView {
  readonly steps: readonly ChecklistStep[];
  readonly done: number;
  readonly total: number;
  readonly progress: string;
  readonly complete: boolean;
}

const KEY_HINT = "Add it to your .env file, then restart wristplan. See the README.";

function step(
  id: ChecklistStep["id"],
  title: string,
  done: boolean,
  blockedBy: string | null,
  todo: string,
  href: string | null = null,
): ChecklistStep {
  if (done) return { id, title, state: "done", hint: "Done.", href: null };
  if (blockedBy !== null) {
    return { id, title, state: "blocked", hint: `Waiting for: ${blockedBy}.`, href: null };
  }
  return { id, title, state: "todo", hint: todo, href };
}

export function buildChecklist(s: SetupStatus): ChecklistView {
  const noDb = s.databaseReady ? null : "the database step";
  const steps = [
    step(
      "database",
      "Database migrated",
      s.databaseReady,
      null,
      "Run pnpm db:migrate (see the README, Migrations), then reload.",
    ),
    step(
      "garmin",
      "Garmin key added",
      s.garminKeyConfigured,
      null,
      `Set GARMIN_PERSONAL_API_KEY. ${KEY_HINT}`,
    ),
    step(
      "intervals",
      "intervals.icu key added",
      s.intervalsKeyConfigured,
      null,
      `Set INTERVALS_API_KEY (and INTERVALS_ATHLETE_ID if needed). ${KEY_HINT}`,
    ),
    step(
      "sync",
      "First sync",
      s.activityCount > 0,
      noDb ?? (s.garminKeyConfigured ? null : "the Garmin key"),
      "Press Sync now below to import your activities.",
    ),
    step(
      "workout",
      "First workout",
      s.workoutCount > 0,
      noDb,
      "Build a workout. Saving it sends nothing anywhere.",
      "/workouts/new",
    ),
    step(
      "schedule",
      "First scheduled workout",
      s.scheduledCount > 0,
      noDb ??
        (s.workoutCount === 0
          ? "your first workout"
          : s.intervalsKeyConfigured
            ? null
            : "the intervals.icu key"),
      "Pick a date for a workout on the calendar.",
      "/calendar",
    ),
  ];
  const done = steps.filter((x) => x.state === "done").length;
  return {
    steps,
    done,
    total: steps.length,
    progress: `${done} of ${steps.length}`,
    complete: done === steps.length,
  };
}

export interface SidebarLine {
  readonly label: string;
  readonly ok: boolean;
  readonly text: string;
}

export interface SidebarView {
  readonly lines: readonly SidebarLine[];
  readonly needsSetup: boolean;
  readonly lastSync: string;
}

const line = (label: string, ok: boolean, good: string, bad: string): SidebarLine => ({
  label,
  ok,
  text: ok ? good : bad,
});

export function buildSidebarView(s: SetupStatus): SidebarView {
  const lines = [
    line("Database", s.databaseReady, "Ready", "Not migrated"),
    line("Garmin key", s.garminKeyConfigured, "Added", "Missing"),
    line("intervals.icu key", s.intervalsKeyConfigured, "Added", "Missing"),
  ];
  return {
    lines,
    needsSetup: lines.some((l) => !l.ok),
    lastSync: s.lastSync
      ? `Latest sync: ${s.lastSync.status}, ${formatTimestamp(s.lastSync.startedAt)}`
      : "Latest sync: never",
  };
}
