import { expect, test } from "@playwright/test";

// Read-only page: this spec has no buttons to click and must never click Sync or any publishing
// button. Rows are seeded straight into e2e.db and removed afterwards; the spec runs in its own
// Playwright project after smoke, workouts and calendar (see playwright.config.ts).

const ANCHOR = "2026-06-17";

async function cleanup() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("e2e.db");
  db.exec(
    `DELETE FROM "ScheduledWorkout" WHERE id LIKE 'e2e-dash-%';
     DELETE FROM "Activity" WHERE id LIKE 'e2e-dash-%';
     DELETE FROM "Workout" WHERE id LIKE 'e2e-dash-%';`,
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
  const scheduled = db.prepare(
    'INSERT INTO "ScheduledWorkout" (id, workoutId, date, status, externalId, matchSource, updatedAt) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
  );
  const plans: [string, string, string | null][] = [
    ["e2e-dash-s1", "2026-06-09", null],
    ["e2e-dash-s2", "2026-06-02", null],
    ["e2e-dash-s3", "2026-06-03", "none"],
    ["e2e-dash-s4", "2099-01-06", null],
  ];
  for (const [id, date, matchSource] of plans) {
    const workoutId = id.replace("-s", "-w");
    workout.run(workoutId, definition(`Dash ${id}`));
    scheduled.run(id, workoutId, date, "published", `wristplan-${id}`, matchSource);
  }
  const activity = db.prepare(
    'INSERT INTO "Activity" (id, garminActivityId, name, sport, startTime, durationSeconds, distanceMeters, updatedAt, lastSyncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  );
  activity.run(
    "e2e-dash-a1",
    "9100000001",
    "Dash run",
    "running",
    "2026-06-16T07:00:00.000Z",
    3600,
    10000,
  );
  activity.run(
    "e2e-dash-a2",
    "9100000002",
    "Dash matched run",
    "running",
    "2026-06-09T07:00:00.000Z",
    1800,
    5000,
  );
  activity.run(
    "e2e-dash-a3",
    "9100000003",
    "Dash ride",
    "cycling",
    "2026-06-10T08:00:00.000Z",
    3725,
    20500,
  );
  activity.run(
    "e2e-dash-a4",
    "9100000004",
    "Dash no data",
    "running",
    "2026-06-10T09:00:00.000Z",
    null,
    null,
  );
  db.close();
});

test("shows the headings, captions and volume per sport", async ({ page }) => {
  await page.goto(`/dashboard?period=week&n=4&date=${ANCHOR}`);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  for (const name of ["Volume per sport", "Planned vs completed", "Trend", "Notes"]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
  await expect(
    page.getByRole("table", { name: /^Activities, duration and distance/ }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: /^Planned workouts completed/ })).toBeVisible();
  await expect(page.getByRole("table", { name: /^Duration change/ })).toBeVisible();
  await expect(page.getByRole("table", { name: /^Distance change/ })).toBeVisible();

  const volume = page.getByRole("table", { name: /^Activities, duration and distance/ });
  await expect(volume.getByRole("columnheader")).toHaveCount(6);
  await expect(volume.getByRole("row", { name: /^Cycling/ })).toContainText(
    "1 · 1:02:05 · 20.50 km",
  );
  const running = volume.getByRole("row", { name: /^Running/ });
  await expect(running).toContainText("1 · 1:00:00 · 10.00 km");
  await expect(running).toContainText("2 · 30:00 (1 of 2) · 5.00 km (1 of 2)");
  await expect(running).toContainText("3 · 1:30:00 (2 of 3) · 15.00 km (2 of 3)");
  await expect(
    page.getByText("Totals exclude activities without a duration/distance."),
  ).toBeVisible();
});

test("shows planned vs completed, trend estimates and notes", async ({ page }) => {
  await page.goto(`/dashboard?period=week&n=4&date=${ANCHOR}`);
  const plans = page.getByRole("table", { name: /^Planned workouts completed/ });
  const overall = plans.getByRole("row", { name: /^Overall/ });
  await expect(overall).toContainText("1 of 2 (50%)");
  await expect(overall).toContainText(
    "30:00 actual vs 10:00 planned (300%) over 1 of 1 matched pairs",
  );
  await expect(
    plans.getByRole("columnheader", { name: "Excluded (No match marked)" }),
  ).toBeVisible();
  await expect(
    plans.getByRole("columnheader", { name: "Excluded (workout unavailable)" }),
  ).toBeVisible();
  await expect(page.getByText("Due means planned for today or earlier.")).toBeVisible();

  await expect(
    page.getByText("Estimate: calculated from stored activities, not a Garmin metric"),
  ).toHaveCount(2);
  await expect(
    page.getByText("Trend metrics from Garmin (load, training effect, HR zones) are not stored."),
  ).toBeVisible();
  await expect(page.getByText("Last sync: never")).toBeVisible();
  await expect(page.getByText("Days are UTC and weeks run Monday to Sunday.")).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});

test("counts a far-future plan as upcoming", async ({ page }) => {
  await page.goto("/dashboard?period=week&n=4&date=2099-01-07");
  const plans = page.getByRole("table", { name: /^Planned workouts completed/ });
  await expect(plans.getByRole("row", { name: /^Overall/ })).toContainText("—");
  await expect(
    plans
      .getByRole("row", { name: /^Mon 2099-01-05/ })
      .getByRole("cell")
      .nth(1),
  ).toHaveText("1");
  await expect(page.getByText("No activities in this range.")).toBeVisible();
});

test("previous, next and latest links keep the period and count", async ({ page }) => {
  await page.goto(`/dashboard?period=week&n=4&date=${ANCHOR}`);
  await expect(page.getByRole("link", { name: "Week", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "4 weeks" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/period=week&n=4&date=2026-07-15/);
  await expect(page.getByText("No activities in this range.")).toBeVisible();

  await page.getByRole("link", { name: "Previous" }).click();
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page).toHaveURL(/period=week&n=4&date=2026-05-20/);

  await page.getByRole("link", { name: "Latest" }).click();
  await expect(page).toHaveURL(/\/dashboard\?period=week&n=4$/);
});

test("previous is plain text at the lower range edge", async ({ page }) => {
  await page.goto("/dashboard?period=week&n=4&date=1970-01-01");
  await expect(page.getByRole("link", { name: "Previous" })).toHaveCount(0);
  await expect(page.getByText("Previous", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Next" })).toBeVisible();
});

test("month view shows month buckets", async ({ page }) => {
  await page.goto(`/dashboard?period=month&n=3&date=${ANCHOR}`);
  const volume = page.getByRole("table", { name: /^Activities, duration and distance/ });
  await expect(volume.getByRole("columnheader", { name: "June 2026" })).toBeVisible();
  await expect(volume.getByRole("columnheader", { name: "April 2026" })).toBeVisible();
  await expect(volume.getByRole("row", { name: /^Running/ })).toContainText("3 · 1:30:00 (2 of 3)");
  await expect(page.getByRole("link", { name: "Month", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByText("The month view compares the running month with a full previous month."),
  ).toBeVisible();
});

test("invalid query parameters fall back to defaults", async ({ page }) => {
  const response = await page.goto("/dashboard?period=bogus&n=99&date=2026-02-31");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Week", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "8 weeks" })).toHaveAttribute("aria-current", "page");
});

test("home links to the dashboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
});
