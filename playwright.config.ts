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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -f e2e.db && pnpm exec prisma migrate deploy && pnpm build && pnpm start -p ${port}`,
    env: { DATABASE_URL: "file:./e2e.db" },
    url: origin,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
