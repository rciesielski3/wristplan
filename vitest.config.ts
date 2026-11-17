import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/modules/**", "src/lib/**"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
