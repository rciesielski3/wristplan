import { expect, type Locator, type Page, test } from "@playwright/test";

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
  // Three items on one day with the same name, to prove each drawer stays bound to its own row.
  for (const [n, status] of [
    [5, "pending"],
    [6, "failed"],
    [7, "published"],
  ] as const) {
    workout.run(`e2e-cal-w${n}`, definition("Cal dup"));
    scheduled.run(
      `e2e-cal-s${n}`,
      `e2e-cal-w${n}`,
      "2026-06-17",
      status,
      `wristplan-e2e-cal-s${n}`,
      null,
    );
  }
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
  await expect(published.getByText("Cal easy run", { exact: true })).toBeVisible();
  await expect(published.getByText("Published")).toBeVisible();

  const failed = page.getByRole("list", { name: "Scheduled on 2026-06-18" });
  await expect(failed.getByText("Failed", { exact: true })).toBeVisible();
  await expect(failed.getByRole("status")).toContainText("PublisherAuthError (401)");
  await expect(failed.getByRole("button", { name: "Actions for Cal tempo" })).toBeVisible();
  await expect(failed.getByRole("button", { name: "Retry Cal tempo" })).toBeHidden();

  const done = page.getByRole("list", { name: "Completed on 2026-06-16" });
  await expect(done.getByText("Cal morning ride")).toBeVisible();
  await expect(done.getByText("cycling, 1:02:05, 20.50 km")).toBeVisible();

  await expect(page.getByRole("table").getByText("Cal long", { exact: true })).toHaveCount(0);
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
  await notDone.getByRole("button", { name: "Actions for Cal easy run" }).click();
  await expect(
    notDone.getByText("Only changes wristplan's local data; nothing is sent to intervals.icu."),
  ).toBeVisible();
});

test("actions drawer opens, groups publishing and local actions, closes and returns focus", async ({
  page,
}) => {
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);
  const plan = page.getByRole("list", { name: "Scheduled on 2026-06-18" });
  const opener = plan.getByRole("button", { name: "Actions for Cal tempo" });
  const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });

  await expect(drawer).toBeHidden();
  await opener.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Intervals.icu (real account)" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Local match (this app only)" })).toBeVisible();
  await expect(drawer.getByText("Acts on your real intervals.icu account.")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Retry Cal tempo" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Link Cal tempo" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.mouse.click(5, 5);
  await expect(drawer).toBeHidden();
});

test("actions drawer fits a 360px viewport as a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);
  await page
    .getByRole("list", { name: "Scheduled on 2026-06-18" })
    .getByRole("button", { name: "Actions for Cal tempo" })
    .click();
  const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("manual link, no match and unlink only change local data", async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${ANCHOR}`);
  const plan = page.getByRole("list", { name: "Scheduled on 2026-06-18" });
  await plan.getByRole("button", { name: "Actions for Cal tempo" }).click();

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

// Every request that could publish or touch Garmin is aborted and recorded for the whole file;
// the specs must never trigger one, and the tripwire fails the test if they do.
const FORBIDDEN = [
  (_m: string, p: string) => p === "/api/sync",
  (m: string, p: string) => m === "POST" && p === "/api/schedule",
  (_m: string, p: string) => /^\/api\/schedule\/[^/]+\/retry$/.test(p),
  (m: string, p: string) => /^\/api\/schedule\/[^/]+$/.test(p) && m !== "GET",
];
let forbidden: string[] = [];
let dialogTypes: string[] = [];

test.beforeEach(async ({ page }) => {
  forbidden = [];
  dialogTypes = [];
  page.on("dialog", (d) => {
    dialogTypes.push(d.type());
    void d.dismiss();
  });
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (FORBIDDEN.some((f) => f(route.request().method(), pathname))) {
      forbidden.push(`${route.request().method()} ${pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
});

test.afterEach(() => {
  expect(forbidden).toEqual([]);
  expect(dialogTypes).toEqual([]);
});

test.describe("actions drawer", () => {
  const week = (page: Page) => page.goto(`/calendar?view=week&date=${ANCHOR}`);
  const day = (page: Page, d: string) => page.getByRole("list", { name: `Scheduled on ${d}` });
  const openerFor = (list: Locator, name: string, index = 0) =>
    list.getByRole("button", { name: `Actions for ${name}` }).nth(index);

  const luminance = (rgb: number[]) => {
    const [r = 0, g = 0, b = 0] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };
  // Resolves any CSS colour (rgb, color(srgb ...)) to rgb via a canvas pixel.
  const colours = (loc: Locator, props: string[]) =>
    loc.evaluate((el, ps) => {
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no canvas");
      return ps.map((p) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = getComputedStyle(el).getPropertyValue(p);
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      });
    }, props);

  for (const [date, name, status] of [
    ["2026-06-16", "Cal easy run", "published"],
    ["2026-06-30", "Cal long", "pending"],
    ["2026-06-18", "Cal tempo", "failed"],
  ] as const) {
    test(`${status} item drawer has both groups, each action next to its warning`, async ({
      page,
    }) => {
      await page.goto(`/calendar?view=month&date=${ANCHOR}`);
      await openerFor(day(page, date), name).click();
      const drawer = page.getByRole("dialog", { name: `Actions for ${name}` });
      const real = drawer.getByRole("region", { name: "Intervals.icu (real account)" });
      const local = drawer.getByRole("region", { name: "Local match (this app only)" });
      await expect(real.getByRole("heading", { level: 3 })).toHaveText(
        "Intervals.icu (real account)",
      );
      await expect(local.getByRole("heading", { level: 3 })).toHaveText(
        "Local match (this app only)",
      );

      // Publishing controls live only in the real-account group, with the warning beside them.
      await expect(real.getByText("Acts on your real intervals.icu account.")).toBeVisible();
      const retry = real.getByRole("button", { name: `Retry ${name}`, exact: true });
      await expect(retry).toHaveCount(status === "published" ? 0 : 1);
      for (const [verb, title] of [
        ["Reschedule", "Moves the event in your real intervals.icu account."],
        ["Remove", "Removes the event from your real intervals.icu account."],
      ] as const) {
        const b = real.getByRole("button", { name: `${verb} ${name}`, exact: true });
        await expect(b).toHaveAttribute("title", title);
        await expect(b.locator("xpath=..")).toContainText(
          "Acts on your real intervals.icu account.",
        );
      }
      if (status !== "published") {
        await expect(retry).toHaveAttribute(
          "title",
          "Publishes to your real intervals.icu account.",
        );
        await expect(retry.locator("xpath=..")).toContainText("real intervals.icu account");
      }
      for (const verb of ["Retry", "Reschedule", "Remove"]) {
        await expect(local.getByRole("button", { name: `${verb} ${name}` })).toHaveCount(0);
      }

      // Local controls live only in the local group, with the local-only notice.
      await expect(
        local.getByText("Only changes wristplan's local data; nothing is sent to intervals.icu."),
      ).toBeVisible();
      await expect(local.getByRole("button", { name: `Link ${name}`, exact: true })).toBeVisible();
      await expect(real.getByRole("button", { name: /^(Link|No match|Unlink)/ })).toHaveCount(0);
      await expect(real.getByText(/local data/)).toHaveCount(0);
    });
  }

  test("same-day items with the same name each open their own drawer", async ({ page }) => {
    await week(page);
    const list = day(page, "2026-06-17");
    await expect(list.getByRole("button", { name: "Actions for Cal dup" })).toHaveCount(3);
    const dialogs = page.getByRole("dialog", { name: "Actions for Cal dup", includeHidden: true });
    await expect(dialogs).toHaveCount(3);

    const labelIds = await page
      .locator("dialog[aria-labelledby]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-labelledby")));
    expect(new Set(labelIds).size).toBe(labelIds.length);
    for (const id of labelIds) expect(await page.locator(`[id="${id}"]`).count()).toBe(1);

    // Rows render pending, failed, published; Retry exists in the first two drawers only.
    const retryPerDrawer: number[] = [];
    for (let i = 0; i < 3; i++) {
      const item = list.locator("li").nth(i);
      await item.getByRole("button", { name: "Actions for Cal dup" }).click();
      const open = item.getByRole("dialog", { name: "Actions for Cal dup" });
      await expect(open).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      retryPerDrawer.push(await open.getByRole("button", { name: "Retry Cal dup" }).count());
      await page.keyboard.press("Escape");
      await expect(open).toBeHidden();
    }
    expect(retryPerDrawer).toEqual([1, 1, 0]);

    // Acting in the second drawer changes only the second row.
    const second = list.locator("li").nth(1);
    await second.getByRole("button", { name: "Actions for Cal dup" }).click();
    await second.getByRole("button", { name: "No match for Cal dup", exact: true }).click();
    await expect(second.getByText("No match (set manually)")).toBeVisible();
    await expect(list.getByText("No match (set manually)")).toHaveCount(1);
    await second.getByRole("button", { name: "Unlink Cal dup", exact: true }).click();
    await expect(list.getByText("No match (set manually)")).toHaveCount(0);
  });

  test("drawer stays open after Link refreshes the page and shows the new match", async ({
    page,
  }) => {
    await week(page);
    const plan = day(page, "2026-06-18");
    await openerFor(plan, "Cal tempo").click();
    const drawer = plan.getByRole("dialog", { name: "Actions for Cal tempo" });
    await drawer
      .getByLabel("Activity to link to Cal tempo")
      .selectOption({ label: "Cal morning ride, 2026-06-16, cycling" });
    await drawer.getByRole("button", { name: "Link Cal tempo", exact: true }).click();
    await expect(plan.locator("> li > .badge", { hasText: "Matched (manual)" })).toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Unlink Cal tempo", exact: true }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Unlink Cal tempo", exact: true }).click();
    await expect(plan.getByText("Planned, not done")).toBeVisible();
    await expect(drawer).toBeVisible();
  });

  test("closing: Escape, Close, backdrop; clicks inside content never close", async ({ page }) => {
    await week(page);
    const plan = day(page, "2026-06-18");
    const opener = openerFor(plan, "Cal tempo");
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await expect(drawer).toBeHidden();

    await opener.click();
    await expect(drawer).toBeVisible();
    // Inside the content: heading, body padding, section padding, a select.
    await drawer.getByRole("heading", { name: "Actions for Cal tempo" }).click();
    await drawer.locator(".drawer-body").click({ position: { x: 2, y: 2 } });
    await drawer.getByRole("region", { name: "Local match (this app only)" }).click({
      position: { x: 2, y: 2 },
    });
    await drawer.getByText("Acts on your real intervals.icu account.").click();
    await expect(drawer).toBeVisible();

    await page.mouse.click(5, 5);
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("empty panel space never closes the drawer, the real backdrop does", async ({ page }) => {
    await week(page);
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await openerFor(day(page, "2026-06-18"), "Cal tempo").click();
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    if (!box) throw new Error("drawer has no box");
    const x = box.x + box.width / 2;
    const bottom = box.y + box.height - 10;
    await page.mouse.click(x, bottom);
    await expect(drawer).toBeVisible();
    await page.mouse.move(x, bottom);
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(drawer).toBeHidden();
  });

  test("empty space below the content in the bottom sheet never closes it", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await week(page);
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await openerFor(day(page, "2026-06-18"), "Cal tempo").click();
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    if (!box) throw new Error("drawer has no box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
    await expect(drawer).toBeVisible();
    await page.mouse.click(box.x + box.width / 2, box.y - 10);
    await expect(drawer).toBeHidden();
  });

  test("a drag that starts inside the drawer and ends on the backdrop keeps it open", async ({
    page,
  }) => {
    await week(page);
    const plan = day(page, "2026-06-18");
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await openerFor(plan, "Cal tempo").click();
    await expect(drawer).toBeVisible();
    const heading = await drawer
      .getByRole("heading", { name: "Actions for Cal tempo" })
      .boundingBox();
    if (!heading) throw new Error("heading has no box");
    await page.mouse.move(heading.x + 4, heading.y + 4);
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(drawer).toBeVisible();
  });

  test("drawer is modal: page behind is inert and focus stays inside while tabbing", async ({
    page,
  }) => {
    await week(page);
    const plan = day(page, "2026-06-18");
    const opener = openerFor(plan, "Cal tempo");
    await opener.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((d) => (d as HTMLDialogElement).matches(":modal"))).toBe(true);
    const insideFocused = () =>
      drawer.evaluate((d) => d.contains(document.activeElement) && d !== document.activeElement);
    // Focus may also leave to the browser UI (body); it must never land on the inert page.
    const notBehind = () =>
      drawer.evaluate((d) => {
        const a = document.activeElement;
        return a === document.body || a === null || d.contains(a);
      });
    await expect.poll(insideFocused).toBe(true);
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press(i % 8 === 7 ? "Shift+Tab" : "Tab");
      expect(await notBehind()).toBe(true);
      seen.add(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
    }
    expect(seen.has("Link Cal tempo") || seen.has("Activity to link to Cal tempo")).toBe(true);
    // Elements behind the modal cannot be clicked or focused.
    const behind = await page
      .getByRole("link", { name: "Dashboard" })
      .first()
      .evaluate((a) => {
        const r = a.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === a;
      });
    expect(behind).toBe(false);
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await expect(drawer).toBeHidden();
  });

  test("closed drawers are absent from the accessibility tree", async ({ page }) => {
    await week(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry Cal tempo" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Intervals.icu (real account)" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("dialog", { name: "Actions for Cal tempo", includeHidden: true }),
    ).toHaveCount(1);
    const display = await page
      .locator("dialog.drawer")
      .first()
      .evaluate((d) => getComputedStyle(d).display);
    expect(display).toBe("none");
  });

  test("bottom sheet at 360px scrolls when content is taller than the viewport", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 360, height: 320 });
    await week(page);
    await openerFor(day(page, "2026-06-18"), "Cal tempo").click();
    const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
    await expect(drawer).toBeVisible();
    const m = await drawer.evaluate((d) => ({
      client: d.clientHeight,
      scroll: d.scrollHeight,
      overflowY: getComputedStyle(d).overflowY,
      top: d.getBoundingClientRect().top,
      bottom: d.getBoundingClientRect().bottom,
    }));
    expect(m.scroll).toBeGreaterThan(m.client);
    expect(m.overflowY).toBe("auto");
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.bottom).toBe(320);
    const notice = drawer.getByText(
      "Only changes wristplan's local data; nothing is sent to intervals.icu.",
    );
    await notice.scrollIntoViewIfNeeded();
    const b = await notice.boundingBox();
    expect((b?.y ?? -1) + (b?.height ?? 0)).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
  });

  test("honours reduced motion and animates otherwise", async ({ page }) => {
    await week(page);
    const open = async () => {
      await openerFor(day(page, "2026-06-18"), "Cal tempo").click();
      const d = page.getByRole("dialog", { name: "Actions for Cal tempo" });
      await expect(d).toBeVisible();
      const name = await d.evaluate((el) => getComputedStyle(el).animationName);
      await page.keyboard.press("Escape");
      return name;
    };
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await open()).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await open()).not.toBe("none");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`drawer text and control borders are legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await week(page);
      await openerFor(day(page, "2026-06-18"), "Cal tempo").click();
      const drawer = page.getByRole("dialog", { name: "Actions for Cal tempo" });
      await expect(drawer).toBeVisible();
      const [bg] = await colours(drawer, ["background-color"]);
      const [ink] = await colours(drawer, ["color"]);
      expect(bg).not.toEqual([0, 0, 0]);
      if (!bg || !ink) throw new Error("no colours");
      expect(ratio(ink, bg)).toBeGreaterThanOrEqual(4.5);
      for (const el of [
        drawer.getByRole("heading", { level: 3 }).first(),
        drawer.getByText("Acts on your real intervals.icu account."),
        drawer.getByText("Only changes wristplan's local data; nothing is sent to intervals.icu."),
        drawer.getByText("2026-06-18", { exact: true }),
      ]) {
        const [fg] = await colours(el, ["color"]);
        if (!fg) throw new Error("no fg");
        expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
      for (const control of [
        drawer.getByRole("button", { name: "Close" }),
        drawer.getByLabel("Activity to link to Cal tempo"),
        drawer.getByLabel("New date for Cal tempo"),
      ]) {
        const [border] = await colours(control, ["border-top-color"]);
        if (!border) throw new Error("no border");
        expect(ratio(border, bg)).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
