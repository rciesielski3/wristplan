import { expect, type Page, test } from "@playwright/test";

const ACTIVE_LINK: Record<string, string> = {
  "/": "Home",
  "/workouts": "Workouts",
  "/workouts/new": "Workouts",
  "/calendar": "Calendar",
  "/dashboard": "Dashboard",
};

async function expectShellLandmarks(page: Page, active: string) {
  await expect(page.getByRole("main")).toHaveCount(1);
  // Pages may add their own differently named navs (calendar, dashboard); only "Main" is the shell.
  await expect(page.locator("nav:not([aria-label])")).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toHaveCount(1);
  await expect(nav.getByRole("link")).toHaveCount(4);
  // Pages may mark their own sub-navs (calendar view, dashboard range); the shell nav has one.
  const strayCurrent = await page.evaluate(
    () => [...document.querySelectorAll("[aria-current]")].filter((e) => !e.closest("nav")).length,
  );
  expect(strayCurrent).toBe(0);
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: active, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
}

test.describe("app shell structure", () => {
  for (const [path, active] of Object.entries(ACTIVE_LINK)) {
    test(`${path} has one main, one Main nav and only ${active} current`, async ({ page }) => {
      await page.goto(path);
      await expectShellLandmarks(page, active);
    });
  }

  test("edit page has the same shell structure with Workouts current", async ({
    page,
    request,
  }) => {
    const created = await request.post("/api/workouts", {
      data: {
        name: "E2E shell",
        sport: "run",
        steps: [
          { kind: "work", end: { type: "time", seconds: 60 }, target: { type: "hr", zone: 2 } },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await page.goto(`/workouts/${id}/edit`);
    await expectShellLandmarks(page, "Workouts");
  });

  test("skip link targets the focusable main landmark", async ({ page }) => {
    await page.goto("/");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toHaveAttribute("href", "#content");
    await expect(page.locator("#content")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveAttribute("id", "content");
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("current link follows client-side navigation", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectShellLandmarks(page, "Dashboard");
  });
});

const NARROW = ["/", "/workouts", "/calendar", "/dashboard"];

test.describe("narrow viewport (360px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test.afterAll(async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync("e2e.db");
    db.exec(`DELETE FROM "Activity" WHERE id LIKE 'e2e-shell-%'`);
    db.close();
  });

  test.beforeAll(async ({ request }) => {
    // Seed a synthetic activity so the home table (8 columns) is rendered with a real row.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync("e2e.db");
    db.exec(`DELETE FROM "Activity" WHERE id LIKE 'e2e-shell-%'`);
    db.prepare(
      'INSERT INTO "Activity" (id, garminActivityId, name, sport, startTime, durationSeconds, distanceMeters, updatedAt, lastSyncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    ).run(
      "e2e-shell-a1",
      "9200000001",
      "Shell narrow run",
      "running",
      "2026-06-16T07:00:00.000Z",
      3600,
      10000,
    );
    db.close();
    // Seed a row so the workouts table (widest content) is actually rendered.
    const res = await request.post("/api/workouts", {
      data: {
        name: "E2E narrow",
        sport: "run",
        steps: [
          { kind: "work", end: { type: "time", seconds: 60 }, target: { type: "hr", zone: 2 } },
        ],
      },
    });
    expect(res.status()).toBe(201);
  });

  for (const path of NARROW) {
    test(`${path} does not scroll horizontally`, async ({ page }) => {
      await page.goto(path);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      const offenders = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)
          .slice(0, 5)
          .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
      );
      expect(scrollWidth, `overflowing: ${offenders.join(", ")}`).toBeLessThanOrEqual(innerWidth);
    });
  }

  test("navigation is a bottom tab bar, not a sidebar", async ({ page }) => {
    await page.goto("/");
    const bar = await page.getByRole("complementary").boundingBox();
    expect(bar).not.toBeNull();
    if (!bar) return;
    expect(bar.width).toBeGreaterThanOrEqual(360 - 1);
    expect(bar.y + bar.height).toBeGreaterThanOrEqual(740 - 1);
    expect(bar.height).toBeLessThan(120);
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(4);
    for (const l of ["Home", "Workouts", "Calendar", "Dashboard"])
      await expect(page.getByRole("link", { name: l, exact: true })).toBeVisible();
  });
});

test.describe("wide viewport (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("navigation is a left sidebar, not a bottom bar", async ({ page }) => {
    await page.goto("/");
    const side = await page.getByRole("complementary").boundingBox();
    expect(side).not.toBeNull();
    if (!side) return;
    expect(side.x).toBe(0);
    expect(side.y).toBe(0);
    expect(side.width).toBeLessThan(300);
    expect(side.height).toBeGreaterThanOrEqual(800 - 1);
    const main = await page.getByRole("main").boundingBox();
    expect(main?.x ?? 0).toBeGreaterThanOrEqual(side.width);
  });
});
