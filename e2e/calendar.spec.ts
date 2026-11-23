import { expect, test } from "@playwright/test";

// This spec must never click Schedule, Retry, Reschedule, Remove or Sync, because those publish to
// the real intervals.icu account or call Garmin when the server has credentials. Link, No match
// and Unlink only write the local e2e.db and may be clicked.

const ANCHOR = "2026-06-17";

// The home smoke spec expects no activities. This spec runs in its own Playwright project that
// depends on the others (see playwright.config.ts) and removes its rows afterwards.
async function cleanup() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("e2e.db");
  db.exec(
    `DELETE FROM "ScheduledWorkout" WHERE id LIKE 'e2e-cal-%';
     DELETE FROM "Activity" WHERE id LIKE 'e2e-cal-%';
     DELETE FROM "Workout" WHERE id LIKE 'e2e-cal-%';`,
  );
  db.close();
}

test.afterAll(cleanup);

test.beforeAll(async () => {
  await cleanup();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("e2e.db");
  const workout = db.prepare(
    'INSERT INTO "Workout" (id, definition, isTemplate, updatedAt) VALUES (?, ?, 0, CURRENT_TIMESTAMP)',
  );
  const definition = (name: string) =>
    JSON.stringify({
      name,
      sport: "run",
      steps: [
        { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
      ],
    });
  workout.run("e2e-cal-w1", definition("Cal easy run"));
  workout.run("e2e-cal-w2", definition("Cal tempo"));
  workout.run("e2e-cal-w3", definition("Cal long"));
  workout.run("e2e-cal-w4", definition("Cal matched run"));
  const scheduled = db.prepare(
    'INSERT INTO "ScheduledWorkout" (id, workoutId, date, status, externalId, lastError, updatedAt) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
  );
  scheduled.run(
    "e2e-cal-s1",
    "e2e-cal-w1",
    "2026-06-16",
    "published",
    "wristplan-e2e-cal-s1",
    null,
  );
  scheduled.run(
    "e2e-cal-s2",
    "e2e-cal-w2",
    "2026-06-18",
    "failed",
    "wristplan-e2e-cal-s2",
    "PublisherAuthError (401)",
  );
  scheduled.run("e2e-cal-s3", "e2e-cal-w3", "2026-06-30", "pending", "wristplan-e2e-cal-s3", null);
  scheduled.run(
    "e2e-cal-s4",
    "e2e-cal-w4",
    "2026-06-15",
    "published",
    "wristplan-e2e-cal-s4",
    null,
  );
  const activity = db.prepare(
    'INSERT INTO "Activity" (id, garminActivityId, name, sport, startTime, durationSeconds, distanceMeters, updatedAt, lastSyncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  );
  // Garmin ids must be numeric for the link API; the row ids keep the cleanup prefix.
  activity.run(
    "e2e-cal-a1",
    "9000000001",
    "Cal morning ride",
    "cycling",
    "2026-06-16T10:00:00.000Z",
    3725,
    20500,
  );
  activity.run(
    "e2e-cal-a2",
    "9000000002",
    "Cal same-day run",
    "running",
    "2026-06-15T07:00:00.000Z",
    660,
    3000,
  );
  db.close();
});

test("home links to the calendar", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  await expect(
    page.getByText("Publishes to your real intervals.icu account.").first(),
  ).toBeVisible();
});

test("week view shows scheduled workouts, statuses and activities", async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);
  await expect(page.getByRole("heading", { name: "2026-06-15 to 2026-06-21" })).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(7);

  const published = page.getByRole("list", { name: "Scheduled on 2026-06-16" });
  await expect(published.getByText("Cal easy run")).toBeVisible();
  await expect(published.getByText("Published")).toBeVisible();

  const failed = page.getByRole("list", { name: "Scheduled on 2026-06-18" });
  await expect(failed.getByText("Failed", { exact: true })).toBeVisible();
  await expect(failed.getByRole("status")).toContainText("PublisherAuthError (401)");
  await expect(failed.getByRole("button", { name: "Retry Cal tempo" })).toBeVisible();

  const done = page.getByRole("list", { name: "Completed on 2026-06-16" });
  await expect(done.getByText("Cal morning ride")).toBeVisible();
  await expect(done.getByText("cycling, 1:02:05, 20.50 km")).toBeVisible();

  await expect(page.getByRole("table").getByText("Cal long")).toHaveCount(0);
});

test("shows auto matches, unplanned activities and unmatched plans", async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);

  const matched = page.getByRole("list", { name: "Scheduled on 2026-06-15" });
  await expect(matched.getByText("Matched (auto)")).toBeVisible();
  await expect(matched).toContainText("Planned 10:00 vs actual 11:00, 3.00 km, delta +1:00");
  await expect(matched).toContainText("Cal same-day run (running) on 2026-06-15");
  await expect(page.getByRole("list", { name: "Completed on 2026-06-15" })).toHaveCount(0);
  await expect(page.getByText("Cal same-day run")).toHaveCount(1);

  const notDone = page.getByRole("list", { name: "Scheduled on 2026-06-16" });
  await expect(notDone.getByText("Planned, not done")).toBeVisible();
  const unplanned = page.getByRole("list", { name: "Completed on 2026-06-16" });
  await expect(unplanned.getByText("Unplanned activity")).toBeVisible();
  await expect(
    notDone.getByText("Only changes wristplan's local data; nothing is sent to intervals.icu."),
  ).toBeVisible();
});

test("manual link, no match and unlink only change local data", async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);
  const plan = page.getByRole("list", { name: "Scheduled on 2026-06-18" });

  await plan
    .getByLabel("Activity to link to Cal tempo")
    .selectOption({ label: "Cal morning ride, 2026-06-16, cycling" });
  await plan.getByRole("button", { name: "Link Cal tempo", exact: true }).click();
  await expect(plan.getByText("Matched (manual)")).toBeVisible();
  await expect(plan).toContainText("Cal morning ride (cycling) on 2026-06-16");
  await expect(plan).toContainText("Planned 10:00 vs actual 1:02:05, 20.50 km, delta +52:05");
  await expect(page.getByRole("list", { name: "Completed on 2026-06-16" })).toHaveCount(0);
  await expect(page.getByText("Cal morning ride")).toHaveCount(1);

  await plan.getByRole("button", { name: "Unlink Cal tempo", exact: true }).click();
  await expect(plan.getByText("Planned, not done")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Completed on 2026-06-16" }).getByText("Unplanned activity"),
  ).toBeVisible();

  await plan.getByRole("button", { name: "No match for Cal tempo", exact: true }).click();
  await expect(plan.getByText("No match (set manually)")).toBeVisible();
  await plan.getByRole("button", { name: "Unlink Cal tempo", exact: true }).click();
  await expect(plan.getByText("Planned, not done")).toBeVisible();
});

test("month view includes leading and trailing days and navigates", async ({ page }) => {
  await page.goto(`/calendar?view=month&date=${ANCHOR}`);
  await expect(page.getByRole("heading", { name: "June 2026" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(6);
  await expect(page.locator('time[datetime="2026-06-01"]')).toBeVisible();
  await expect(page.locator('time[datetime="2026-07-05"]')).toBeVisible();
  const pending = page.getByRole("list", { name: "Scheduled on 2026-06-30" });
  await expect(pending.getByText("Pending")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Completed on 2026-06-16" }).getByText("Cal morning ride"),
  ).toBeVisible();

  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/view=month&date=2026-07-01/);
  await expect(page.getByRole("heading", { name: "July 2026" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Month" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Week" }).click();
  await expect(page).toHaveURL(/view=week&date=2026-07-01/);
  await expect(page.getByRole("columnheader")).toHaveCount(7);
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page).toHaveURL(/view=week&date=2026-06-24/);
});

test("invalid query parameters fall back to the current week", async ({ page }) => {
  const response = await page.goto("/calendar?view=bogus&date=2026-02-31");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Week" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("columnheader")).toHaveCount(7);
});
