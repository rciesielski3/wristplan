import { expect, test } from "@playwright/test";

test("home page responds 200 with the app heading", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "wristplan" })).toBeVisible();
});

test("home page renders the sync button and empty activity list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(page.getByText("No activities yet.")).toBeVisible();
});

test("sidebar nav has four links and marks the current one", async ({ page }) => {
  await page.goto("/workouts");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveCount(4);
  await expect(nav.getByRole("link", { name: "Workouts" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current", "page");
});
