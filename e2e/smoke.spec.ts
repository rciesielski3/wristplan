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
