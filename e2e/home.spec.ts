import { expect, test } from "@playwright/test";

// Read-only page: never click Sync. Rows are seeded straight into e2e.db around the current day
// (the server's "today" is real) and removed afterwards; runs in its own project after shell.

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0"))
    .join("-");
};

async function cleanup() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("e2e.db");
  db.exec(
    `DELETE FROM "ScheduledWorkout" WHERE id LIKE 'e2e-home-%';
     DELETE FROM "Activity" WHERE id LIKE 'e2e-home-%';
     DELETE FROM "Workout" WHERE id LIKE 'e2e-home-%';`,
  );
  db.close();
}

test.afterAll(cleanup);

// Seeded before every test so a midnight rollover between tests cannot leave rows on a stale day.
test.beforeEach(async () => {
  await cleanup();
  const TODAY = day(0);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("e2e.db");
  db.prepare(
    'INSERT INTO "Workout" (id, definition, isTemplate, updatedAt) VALUES (?, ?, 0, CURRENT_TIMESTAMP)',
  ).run(
    "e2e-home-w1",
    JSON.stringify({
      name: "Home tempo",
      sport: "run",
      steps: [
        { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
      ],
    }),
  );
  db.prepare(
    'INSERT INTO "ScheduledWorkout" (id, workoutId, date, status, externalId, updatedAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
  ).run("e2e-home-s1", "e2e-home-w1", TODAY, "published", "wristplan-e2e-home-s1");
  db.prepare(
    'INSERT INTO "Activity" (id, garminActivityId, name, sport, startTime, durationSeconds, distanceMeters, updatedAt, lastSyncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  ).run(
    "e2e-home-a1",
    "9300000001",
    "Home cycle",
    "cycling",
    `${day(-1)}T12:00:00.000Z`,
    3600,
    20000,
  );
  db.close();
});

test("home shows the Today card, the week strip and KPI tiles for seeded rows", async ({
  page,
}) => {
  await page.goto("/");
  const today = page.getByRole("region", { name: "Today" });
  await expect(today).toContainText("Home tempo");
  await expect(today).toContainText("Due");

  const strip = page.getByRole("region", { name: "This week" });
  await expect(strip.getByRole("listitem")).toHaveCount(7);
  await expect(strip.locator("li.today")).toContainText("Planned 1");

  const kpis = page.getByRole("region", { name: "Last 8 weeks" });
  await expect(kpis.locator("div").filter({ hasText: "Activities" }).locator("dd")).toHaveText("1");
  await expect(kpis).toContainText("20.00 km");
  await expect(kpis).toContainText("1:00:00");

  await expect(page.getByRole("region", { name: "Get started" })).toContainText("To do");
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("home stays within a 360px viewport with the cards", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "This week" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Setup" })).toBeHidden();
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});
