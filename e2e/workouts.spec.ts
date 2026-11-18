import { expect, test } from "@playwright/test";

test("build, list, duplicate and delete a workout", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Workouts" }).click();
  await expect(page.getByRole("heading", { name: "Workouts", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "New workout" }).click();
  await page.getByLabel("Name").fill("E2E tempo");
  await page.getByLabel("Step 1 duration (min:sec)").fill("15:00");
  await page.getByLabel("Step 1 heart rate zone (1-5)").fill("1");
  await page.getByRole("button", { name: "Add repeat" }).click();
  await expect(page.getByLabel("Step 2.1 heart rate zone (1-5)")).toHaveValue("1");
  await page.getByLabel("Step 2.1 heart rate zone (1-5)").fill("4");
  await expect(page.getByLabel("Step 2.1 duration (min:sec)")).toBeVisible();
  await expect(page.getByText("Main set 4x")).toBeVisible();
  await expect(page.getByText("- 15m Z1 HR")).toBeVisible();
  await expect(page.getByText("- 3m Z4 HR")).toBeVisible();
  await expect(page.getByText("- 3m Z1 HR")).toBeVisible();

  await page.getByLabel("Step 1 duration (min:sec)").fill("bad");
  await expect(page.getByText("steps[0].end.seconds")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create workout" })).toBeDisabled();
  await page.getByLabel("Step 1 duration (min:sec)").fill("15:00");
  await page.getByRole("button", { name: "Create workout" }).click();

  await expect(page).toHaveURL(/\/workouts$/);
  const row = (name: string) => page.getByRole("row", { name });
  await expect(row("E2E tempo")).toHaveCount(1);

  await row("E2E tempo").getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByRole("row", { name: /E2E tempo \(copy\)/ })).toHaveCount(1);

  page.on("dialog", (d) => d.accept());
  await page
    .getByRole("row", { name: /E2E tempo \(copy\)/ })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByRole("row", { name: /E2E tempo \(copy\)/ })).toHaveCount(0);
  await expect(row("E2E tempo")).toHaveCount(1);
});

test.describe("workout API wiring", () => {
  const body = {
    name: "E2E api",
    sport: "run",
    steps: [{ kind: "work", end: { type: "time", seconds: 60 }, target: { type: "hr", zone: 2 } }],
  };

  test("routes enforce methods, CSRF and host guards", async ({ request }) => {
    const created = await request.post("/api/workouts", { data: body });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const count = async () =>
      ((await (await request.get("/api/workouts")).json()) as { items: unknown[] }).items.length;
    const before = await count();

    expect((await request.patch("/api/workouts")).status()).toBe(405);
    expect((await request.post(`/api/workouts/${id}/text`)).status()).toBe(405);

    const evil = { origin: "http://evil.example" };
    for (const path of [`/${id}/duplicate`, `/${id}/use-template`]) {
      expect((await request.post(`/api/workouts${path}`, { headers: evil })).status()).toBe(403);
    }
    expect((await request.post("/api/workouts", { data: body, headers: evil })).status()).toBe(403);
    const cross = { "sec-fetch-site": "cross-site" };
    expect((await request.delete(`/api/workouts/${id}`, { headers: cross })).status()).toBe(403);
    expect((await request.put(`/api/workouts/${id}`, { data: body, headers: evil })).status()).toBe(
      403,
    );
    expect(await count()).toBe(before);

    const text = await request.get(`/api/workouts/${id}/text`);
    expect(text.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(text.headers()["x-content-type-options"]).toBe("nosniff");
    expect((await request.head(`/api/workouts/${id}/text`)).status()).toBe(200);

    expect((await request.get("/api/workouts/..%2Fetc")).status()).toBe(404);
    expect(
      (
        await request.post("/api/workouts", {
          data: "x",
          headers: { "content-type": "text/plain" },
        })
      ).status(),
    ).toBe(415);

    expect((await request.delete(`/api/workouts/${id}`)).status()).toBe(200);
    expect(await count()).toBe(before - 1);
  });

  test("a foreign Host header is rejected", async ({ request }) => {
    const res = await request.get("/api/workouts", { headers: { host: "evil.example" } });
    expect(res.status()).toBe(403);
  });
});

test("a stored workout the builder cannot represent is not editable", async ({ page }) => {
  const { DatabaseSync } = await import("node:sqlite");
  const power = (unit: string) => ({ type: "power", unit, min: 50, max: 90 });
  const step = (unit: string) => ({
    kind: "work",
    end: { type: "time", seconds: 60 },
    target: power(unit),
  });
  const db = new DatabaseSync("e2e.db");
  db.prepare(
    'INSERT INTO "Workout" (id, definition, isTemplate, updatedAt) VALUES (?, ?, 0, CURRENT_TIMESTAMP)',
  ).run(
    "e2e-mixed-units",
    JSON.stringify({ name: "Mixed", sport: "run", steps: [step("watts"), step("percent_ftp")] }),
  );
  db.close();

  await page.goto("/workouts/e2e-mixed-units/edit");
  await expect(page.getByText("This workout cannot be edited in the builder.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create workout" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to workouts" })).toBeVisible();

  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/workouts$/);
  const res = await page.request.get("/api/workouts/e2e-mixed-units");
  expect(res.status()).toBe(404);
});
