import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: origin,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["calendar.spec.ts", "dashboard.spec.ts", "shell.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    // Seeds rows that the home page lists, so it runs only after the other specs finished.
    {
      name: "calendar",
      testMatch: "calendar.spec.ts",
      dependencies: ["chromium"],
      use: { ...devices["Desktop Chrome"] },
    },
    // Also seeds activities; runs after calendar so the seeded rows never overlap.
    {
      name: "dashboard",
      testMatch: "dashboard.spec.ts",
      dependencies: ["calendar"],
      use: { ...devices["Desktop Chrome"] },
    },
    // Seeds workouts to render the widest tables; runs last so no spec counts rows concurrently.
    {
      name: "shell",
      testMatch: "shell.spec.ts",
      dependencies: ["dashboard"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `rm -f e2e.db && pnpm exec prisma migrate deploy && pnpm build && pnpm start -p ${port}`,
    env: { DATABASE_URL: "file:./e2e.db" },
    url: origin,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
